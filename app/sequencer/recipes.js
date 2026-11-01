// The recipe engine: analysis.json + your role mapping → a list of effects.
//
// Every effect is { el, role, start, end, effect, settings, colors, brightness }
// with times in seconds. Layers are assigned later (xsq.js) by role priority,
// so a prop that plays two roles never has two effects fighting on one layer.
//
// The show follows the song's INTENSITY, bar by bar:
//   low   quiet / sparse bars — fewer props lit, slow pulses, long fades
//   mid   normal groove — the backbeat and a pulse on 1 and 3
//   high  the big parts — every beat, faster chases, hands waving twice a bar
//   calm  a slow song's quiet bars — everything stays lit, just slow and soft
// Intensity is measured against the song itself, so every song gets contrast.
const { expand } = require('./layout');
const lib = require('./library');
const { findCues } = require('./cues');
const { makeLook } = require('./look');

const C = {
  orange: '#FF5A00', purple: '#7B00FF', green: '#3CFF00', red: '#D00000',
  magenta: '#FF00A0', amber: '#FFA000', teal: '#00D0B0', white: '#FFFFFF',
};

// Section colour pairs — Halloween leaning. Pair[0] is the main colour.
const SECTION_COLORS = {
  intro: [C.purple, C.green], verse: [C.purple, C.orange], prechorus: [C.green, C.orange],
  chorus: [C.orange, C.purple], bridge: [C.green, C.red], break: [C.red, C.purple],
  outro: [C.purple, C.green], custom: [C.orange, C.purple],
};

const BIG = new Set(['chorus', 'prechorus', 'bridge']);
const TIER_THRESHOLDS = { high: 0.68, low: 0.25 };   // percentiles of the song's own bars

function build(analysis, layout, roles, opts = {}) {
  const a = analysis;
  const slowSong = a.tempoBand === 'slow';
  const sections = (a.sections || []).filter(s => s.type !== 'off');
  const occurrence = {};
  sections.forEach(s => { s.n = occurrence[s.type] = (occurrence[s.type] || 0) + 1; });
  const sectionAt = t => sections.find(s => t >= s.start && t < s.end);
  // colours come from the section's theme (x-onset themes, boosted to full brightness)
  const seed = opts.seed || 0;
  // the song's look: its own colour scheme, signature effects and chorus moves (see look.js)
  const lookShow = opts.theme === 'christmas' ? 'christmas' : (opts.showKind || 'halloween');
  const look = makeLook({ seed, show: lookShow, themeByName: lib.themeByName });
  const themeOf = s => lib.themeFor(s?.type || 'custom', opts.theme, opts.cover, look);
  // how bright the between-hit glow is: the "try a few" pass compares these and keeps
  // whichever fits the music best (from full glow down to dark between hits in quiet bars)
  const GLOW = [[42, 30], [35, 15], [28, 0], [45, 20]][seed % 4];
  // colour story: verses take turns with the pair (A-verse, B-verse), quiet bars use the
  // second colour; the seed decides which verse starts
  const colorsOf = s => {
    const [a1, a2] = lib.colors(themeOf(s)).pair;
    const swap = (s?.type === 'verse' || s?.type === 'custom') && (s.n + seed) % 2 === 0;
    return swap ? [a2, a1] : [a1, a2];
  };
  const paletteOf = s => lib.colors(themeOf(s)).all;
  const targets = key => expand(layout, roles[key] || []);
  const out = [];
  const push = (el, role, start, end, effect, settings, colors, brightness = 100) => {
    if (end - start >= 0.025) out.push({ el, role, start, end, effect, settings, colors, brightness: Math.round(brightness) });
  };

  const beats = a.beats || [];
  const beatLen = beats.length > 1 ? (beats[beats.length - 1] - beats[0]) / (beats.length - 1) : 0.6;
  const downbeats = (a.downbeats || []).slice();
  const near = (list, t, tol) => (list || []).some(h => Math.abs(h.time - t) <= tol);
  const pulse = (end = 35) => ({ E_TEXTCTRL_Eff_On_Start: 100, E_TEXTCTRL_Eff_On_End: end, E_CHECKBOX_On_Shimmer: 0 });
  const steady = { E_TEXTCTRL_Eff_On_Start: 100, E_TEXTCTRL_Eff_On_End: 100 };

  // ---------------------------------------------------------- bars + intensity
  const bars = downbeats.map((d, i) => {
    const end = downbeats[i + 1] ?? Math.min(d + 4 * beatLen, a.duration);
    return { start: d, end, section: sectionAt(d), beats: beats.filter(t => t >= d - 0.03 && t < end - 0.03) };
  }).filter(b => b.section && b.end > b.start);
  scoreIntensity(a, bars, sections, slowSong);
  const tiers = bars.reduce((m, b) => (m[b.tier] = (m[b.tier] || 0) + 1, m), {});
  out.tiers = tiers;

  // the last chorus is the peak of the song
  const choruses = sections.filter(x => x.type === 'chorus');
  const lastChorus = choruses[choruses.length - 1];
  if (lastChorus) bars.filter(b => b.section === lastChorus && b.tier === 'mid').forEach(b => { b.tier = 'high'; });
  // a chorus should always read bigger than the verses, even in songs (like most rock)
  // where the verses are just as loud: never quiet, and a step up when it isn't already ahead
  {
    const avg = type => { const x = bars.filter(b => b.section.type === type); return x.reduce((t, b) => t + b.intensity, 0) / Math.max(1, x.length); };
    const ahead = avg('chorus') - avg('verse');
    for (const b of bars.filter(x => x.section.type === 'chorus')) {
      if (b.tier === 'low') b.tier = slowSong ? 'calm' : 'mid';
      else if (ahead < 0.08 && b.tier === 'mid' && !slowSong) b.tier = 'high';
    }
  }

  // in big sections the colour pair swaps bar by bar
  const barIndexIn = new Map();
  bars.forEach(b => { const n = (barIndexIn.get(b.section) ?? -1) + 1; barIndexIn.set(b.section, n); b.i = n; });
  const barColors = b => {
    const [c1, c2] = colorsOf(b.section);
    return BIG.has(b.section.type) && b.tier !== 'low' && b.i % 2 ? [c2, c1] : [c1, c2];
  };

  // lifts: a section boundary where the next part is clearly bigger than this one
  const meanI = s2 => { const x = bars.filter(b => b.section === s2); return x.reduce((t, b) => t + b.intensity, 0) / Math.max(1, x.length); };
  const lifts = [];
  for (let i = 1; i < sections.length; i++) {
    const prev = sections[i - 1], next = sections[i];
    const prevBars = bars.filter(b => b.section === prev);
    const firstBar = bars.find(b => b.section === next);
    if (!firstBar || prevBars.length < 3) continue;
    if (meanI(next) - meanI(prev) > 0.12 || (BIG.has(next.type) && !BIG.has(prev.type))) {
      lifts.push({ at: firstBar.start, buildFrom: prevBars[Math.max(0, prevBars.length - 2)].start, section: next });
    }
  }
  out.lifts = lifts.length;

  // how fast things move: the song's tempo (120 BPM = 1×) times the bar's intensity
  const TIER_PACE = { low: 0.6, calm: 0.7, mid: 1, high: 1.6 };
  const paceOf = b => Math.max(0.4, Math.min(2.5, ((a.bpm || 120) / 120) * (TIER_PACE[b.tier] || 1)));

  // shader speed by intensity (x-onset found xLights' 100+ far too fast; 14 matched a 78 BPM part)
  const shaderSpeed = b => (b.tier === 'high' ? 50 : b.tier === 'mid' ? 25 : 14);
  const brightnessOf = b => Math.round(b.tier === 'low' ? 75 : b.tier === 'calm' ? 85 : b.tier === 'mid' ? 92 : 100);

  // ---------------------------------------------------------- prop sizes
  // A preset that looks great on a 500-pixel roofline is a few random blips on a
  // 22-pixel star and just flickers a 1-pixel flood. So effects are chosen by size:
  //   point  (≤ 4 pixels: floods)        hits and colour only, never patterns, never dim-steady
  //   small  (≤ 80 pixels: hands, rack)  solid-looking effects (washes, shimmer, star shapes)
  //   large  (lines, matrices)           anything from the library
  const sizeOf = m => m.type === 'Matrix' ? 'large' : (m.nodes || 1) <= 4 ? 'point' : (m.nodes || 1) <= 80 ? 'small' : 'large';
  const SMALL_OK = ['Color Wash', 'Shimmer', 'Twinkle', 'Pinwheel', 'Ripple', 'Plasma', 'Butterfly'];
  const lastOn = new Map();
  const pickFor = (m, tier, sec, theme, sd, role) => {
    const size = sizeOf(m);
    // a strobe is great for a moment, but held for a whole intro it's just static noise;
    // and a prop never gets the same effect twice in a row
    let v = lib.pick({ model: m, tier, section: sec, theme, seed: sd, role, exclude: ['On', 'Fireworks', 'Strobe', lastOn.get(m.name)].filter(Boolean),
      only: size === 'small' ? SMALL_OK : null });
    if (!v) v = lib.pick({ model: m, tier, section: sec, theme, seed: sd, role, exclude: ['On', 'Fireworks', 'Strobe'],
      only: size === 'small' ? SMALL_OK : null });
    if (v && v.effect === 'Twinkle' && size === 'small') v.settings = { ...v.settings, E_SLIDER_Twinkle_Count: 45 };
    if (v) lastOn.set(m.name, v.effect);
    return v;
  };
  // a point prop given a "moving" role pulses on the bar instead (and is dark between)
  const pointPulse = (m, role, b) => {
    if (!b.drums && b.tier === 'low') return;
    const [c1, c2] = barColors(b);
    const beats = b.tier === 'high' ? b.beats : b.beats.filter((_, i) => i % 2 === 0);
    beats.forEach((t, i) => push(m.name, role, t, Math.min(t + beatLen * 0.9, b.end), 'On', pulse(0), [i ? c1 : c2], brightnessOf(b)));
  };
  const kickSet = new Set(targets('kick').map(m => m.name)), snareSet = new Set(targets('snare').map(m => m.name));

  // ---------------------------------------------------------- background
  // one effect per stretch of same-tier bars, picked from the preset library by
  // prop size, intensity and section; a repeated section gets a different preset
  const bgProps = targets('background');
  for (const m of bgProps) {
    if (sizeOf(m) === 'point') {
      if (!kickSet.has(m.name)) bars.forEach(b => pointPulse(m, 'background', b));   // floods already hitting skip this
      continue;
    }
    let k = 0;
    for (const run of stableRuns(bars)) {
      const s = run[0].section, tier = run[0].tier;
      const start = run[0].start, end = run[run.length - 1].end;
      const v = pickFor(m, tier, s.type, themeOf(s), s.n + k++ + seed * 3, 'background');
      if (v) push(m.name, 'background', start, end, v.effect, lib.pace(v.effect, v.settings, paceOf(run[0])), paletteOf(s), brightnessOf(run[0]));
      else push(m.name, 'background', start, end, 'Color Wash', { E_TEXTCTRL_ColorWash_Cycles: '1.0' }, colorsOf(s), brightnessOf(run[0]));
    }
  }

  // ---------------------------------------------------------- sweeps
  // none in low bars, one per bar (every other bar outside big sections) in mid, two per bar in high.
  // A big prop (roofline) gets a chase along itself; several smaller props get a sweep
  // that TRAVELS ACROSS them, left to right then back, one prop after another.
  const sweepProps = targets('bars');
  const sweepBig = sweepProps.filter(m => sizeOf(m) === 'large');
  const sweepRow = sweepProps.filter(m => sizeOf(m) !== 'large' && !kickSet.has(m.name) && !snareSet.has(m.name));
  {
    let dir = 0;
    bars.forEach((b, i) => {
      const s = b.section;
      const [c1, c2] = colorsOf(s);
      const sweep = (t0, t1) => {
        const d = dir++ % 2;
        sweepBig.forEach(m => push(m.name, 'bars', t0, t1, 'Single Strand', {
          E_CHOICE_Chase_Type1: d ? 'Left-Right' : 'Right-Left',
          E_TEXTCTRL_Chase_Rotations: '1.0', E_SLIDER_Color_Mix1: 18, E_CHOICE_Fade_Type: 'Head and Tail',
        }, [c2, c1], brightnessOf(b)));
        if (sweepRow.length) {
          const order = d ? sweepRow : [...sweepRow].reverse();
          const span = (t1 - t0) / order.length;
          order.forEach((m, k) => push(m.name, 'bars', t0 + k * span, t0 + k * span + Math.max(span * 1.6, beatLen * 0.5), 'On', pulse(0), [c2], brightnessOf(b)));
        }
      };
      if (b.tier === 'high') {
        const mid = b.beats[2] ?? (b.start + b.end) / 2;
        sweep(b.start, mid); sweep(mid, b.end);
      } else if (b.tier === 'mid' && (BIG.has(s.type) || i % 2 === 0)) {
        sweep(b.start, b.end);
      }
    });
  }

  // ---------------------------------------------------------- kick → floods
  // Floods aren't made to sit dim: they're off unless they're hitting, and every hit
  // fades all the way out. How often they hit follows the bar's intensity.
  const kickProps = targets('kick');
  if (kickProps.length) {
    const left = kickProps.slice(0, Math.ceil(kickProps.length / 2));
    const right = kickProps.slice(Math.ceil(kickProps.length / 2));
    const isFlood = m => /flood/i.test(m.name) || (m.nodes || 1) <= 4;
    const glowable = kickProps.filter(m => !isFlood(m));          // non-flood kick props may still glow
    for (const b of bars) {
      const s = b.section, [c1, c2] = barColors(b), bb = b.beats;
      const glowK = b.tier === 'low' ? GLOW[1] : GLOW[0];
      if (glowK && glowable.length) push2(glowable, 'kick-ambient', b.start, b.end, 'On', steady, [brighter([c1, c2])], glowK);
      if (!b.drums || !bb.length) continue;
      if (b.tier === 'low') {                       // one swell per bar that fades to dark
        push2(kickProps, 'kick', bb[0], Math.min(bb[0] + beatLen * 2.5, b.end), 'On', pulse(0), [c1], 80);
      } else if (b.tier === 'calm') {               // slow song: 1 and 3, long soft fades
        bb.filter((_, i) => i % 2 === 0).forEach(t =>
          push2(kickProps, 'kick', t, Math.min(t + 1.8 * beatLen, b.end), 'On', pulse(0), [c1], 85));
      } else if (b.tier === 'mid') {                // where the kick really is (or 1 and 3), punchy
        let hits = bb.filter(t => near(a.drums?.kick, t, 0.07));
        if (hits.length >= bb.length || !hits.length) hits = bb.filter((_, i) => i % 2 === 0);
        hits.forEach((t, n) => {
          const down = bb.indexOf(t) === 0;
          const who = BIG.has(s.type) && right.length ? (n % 2 ? right : left) : kickProps;
          push2(who, 'kick', t, Math.min(t + beatLen * 0.9, b.end + beatLen), 'On', pulse(0), [down ? c2 : c1], 100);
        });
      } else {                                      // high: every beat left/right, plus the off-beat kicks
        bb.forEach((t, i) => {
          push2(i % 2 ? right : left, 'kick', t, t + beatLen * 0.6, 'On', pulse(0), [i === 0 ? C.white : c1], 100);
          const and = t + beatLen / 2;
          if (right.length && near(a.drums?.kick, and, 0.06)) {
            push2(i % 2 ? left : right, 'kick', and, and + beatLen * 0.4, 'On', pulse(0), [c2], 90);
          }
        });
      }
    }
  }

  // ---------------------------------------------------------- snare → hands (a row of props)
  // A row of matching props gets a PATTERN per 4-bar phrase instead of all flashing
  // together: odd/even, halves answering each other, chases across, centre-out,
  // ping-pong, pairs walking. Busier patterns in more intense bars; the backbeat
  // always lands somewhere, so they stay in sync with the song while each prop has
  // its own part. On the bar's first beat in big bars the row gets a star ripple.
  const snareProps = targets('snare');
  if (snareProps.length) {
    const N = snareProps.length;
    const PAT = {
      low: ['walk', 'oddeven', 'single'],
      calm: ['oddeven', 'all', 'walk'],
      mid: ['oddeven', 'halves', 'pairs', 'centre', 'all'],
      high: ['chase', 'pingpong', 'centre', 'halves', 'chase8'],
    };
    const centreOrder = [...snareProps.keys()].sort((x, y) => Math.abs(x - (N - 1) / 2) - Math.abs(y - (N - 1) / 2));
    let back = 0, step = 0;
    bars.forEach((b, bi) => {
      const s = b.section, [c1, c2] = barColors(b), bb = b.beats;
      const quiet = b.tier === 'low';
      const glowS = quiet ? GLOW[1] : GLOW[0] + 3;
      if (glowS) push2(quiet ? snareProps.filter((_, i) => i % 2 === 0) : snareProps, 'snare-ambient', b.start, b.end, 'On', steady,
        [brighter([c1, c2])], glowS);
      if (!b.drums || !bb.length) return;
      const list = PAT[b.tier] || PAT.mid;
      const phrase = Math.floor((b.i || 0) / 4);
      const pat = N < 3 ? 'all' : list[(phrase + seed + (s.n || 0)) % list.length];
      const hold = b.tier === 'high' ? 0.55 : quiet ? 1.2 : 0.85;
      const hit = (props, t, color, len = beatLen * hold) =>
        props.forEach(m => push(m.name, 'snare', t, t + len, 'On', pulse(0), [color], quiet ? 85 : 100));
      const backColor = () => (BIG.has(s.type) && b.tier !== 'low' ? [C.white, c2] : [c2, c1])[back++ % 2];

      bb.forEach((t, i) => {
        const backbeat = i % 2 === 1;
        switch (pat) {
          case 'all':                                 // everyone on the backbeat
            if (backbeat) hit(snareProps, t, backColor());
            break;
          case 'single':                              // one hand at a time, slowly across, on the backbeat
            if (backbeat) hit([snareProps[step++ % N]], t, c2);
            break;
          case 'walk':                                // a pair walks across on every beat
            hit([snareProps[(step * 2) % N], snareProps[(step * 2 + 1) % N]], t, backbeat ? c2 : c1); step++;
            break;
          case 'oddeven':                             // odd hands on 2, even hands on 4, colours swap
            if (backbeat) hit(snareProps.filter((_, k) => k % 2 === (i === 1 ? 0 : 1)), t, i === 1 ? c2 : c1);
            break;
          case 'halves':                              // left half on 2, right half on 4, both on the next bar's 2
            if (backbeat) hit(i === 1 ? snareProps.slice(0, Math.ceil(N / 2)) : snareProps.slice(Math.ceil(N / 2)), t, backColor());
            break;
          case 'pairs': {                             // a different pair lights on each beat, moving outward
            const k = (step++ % Math.ceil(N / 2));
            hit([snareProps[Math.ceil(N / 2) - 1 - k], snareProps[Math.floor(N / 2) + k]].filter(Boolean), t, backbeat ? c2 : c1);
            break;
          }
          case 'centre': {                            // centre-out burst on the backbeat
            if (!backbeat) break;
            const span = beatLen * 0.45 / Math.ceil(N / 2);
            centreOrder.forEach((k, r) => hit([snareProps[k]], t + Math.floor(r / 2) * span, backColor(), beatLen * 0.5));
            break;
          }
          case 'chase': case 'chase8': {              // a chase across the row every beat (or every half beat)
            const parts = pat === 'chase8' ? [t, t + beatLen / 2] : [t];
            parts.forEach((t0, h) => {
              const dir = (i + h + bi) % 2 === 0;
              const order = dir ? snareProps : [...snareProps].reverse();
              const span = (beatLen / parts.length) * 0.9 / N;
              order.forEach((m, k) => hit([m], t0 + k * span, backbeat ? c2 : c1, beatLen * 0.35));
            });
            break;
          }
          case 'pingpong': {                          // one hand bounces end to end, one step per half beat
            for (const h of [0, 0.5]) {
              const pos = step++ % (2 * N - 2 || 1);
              const k = pos < N ? pos : 2 * N - 2 - pos;
              hit([snareProps[k]], t + h * beatLen, backbeat && h === 0 ? C.white : c1, beatLen * 0.45);
            }
            break;
          }
        }
      });
      // a star ripple across all hands at the top of big, intense bars
      if (b.tier === 'high' && BIG.has(s.type) && bb.length && snareProps[0].type === 'Star' && bi % 2 === 0) {
        snareProps.forEach(m => push(m.name, 'land', bb[0], bb[0] + beatLen * 0.9, 'Ripple', {
          E_CHOICE_Ripple_Object_To_Draw: 'Star', E_CHOICE_Ripple_Movement: 'Explode', E_SLIDER_Ripple_Thickness: 3,
          E_TEXTCTRL_Ripple_Cycles: '1.0', E_SLIDER_Ripple_Points: 5 }, [c1, C.white], 100));
      }
      b.handPattern = pat;
    });
    out.handPatterns = [...new Set(bars.map(b => b.handPattern).filter(Boolean))];
  }

  // ---------------------------------------------------------- toms: step across left → right through a fill
  const tomProps = targets('toms');
  if (tomProps.length) {
    let step = 0, last = -9;
    for (const h of a.drums?.toms || []) {
      if (!sectionAt(h.time)) continue;
      if (h.time - last > 1.5) step = 0;
      last = h.time;
      const m = tomProps[step++ % tomProps.length];
      push(m.name, 'toms', h.time, h.time + Math.max(0.2, beatLen * 0.5), 'On', pulse(), [C.amber], 100);
    }
  }

  // ---------------------------------------------------------- crash: only on bar lines, in mid/high bars
  const crashProps = targets('crash').filter(m => m.type !== 'Matrix');
  let lastCrash = -9;
  for (const h of a.drums?.crash || []) {
    const b = bars.find(x => Math.abs(x.start - h.time) <= 0.1);
    if (!b || b.tier === 'low' || b.start - lastCrash < 4 * beatLen) continue;
    lastCrash = b.start;
    push2(crashProps, 'crash', b.start, b.start + beatLen * 1.5, 'On', pulse(0), [C.white], 100);
  }

  // ---------------------------------------------------------- vocals → singing face
  const spans = vocalSpans(a.phrases || []);
  // "none": no singing face for this song (or this show), the matrix keeps its visuals
  const noFace = opts.face === 'none' || (!opts.face && roles.face === 'none');
  for (const m of noFace ? [] : targets('vocals')) {
    if (!m.faces.length) continue;
    const face = m.faces.includes(opts.face) ? opts.face : m.faces.includes(roles.face) ? roles.face : m.faces[0];
    for (const v of spans) {
      push(m.name, 'vocals', Math.max(0, v.start - 0.1), v.end + 0.3, 'Faces', {
        E_CHOICE_Faces_FaceDefinition: face, E_CHOICE_Faces_TimingTrack: 'AutoSeq Lyrics',
        E_CHOICE_Faces_Eyes: 'Auto', E_CHECKBOX_Faces_Outline: 0,
        // let the matrix visuals show through the black around the face
        E_CHECKBOX_Faces_TransparentBlack: 1, E_TEXTCTRL_Faces_TransparentBlack: 20,
      }, [C.white], 100);
    }
  }

  // ---------------------------------------------------------- matrix visuals (paced by tier)
  let mk = 0;
  const bgNames = new Set(bgProps.map(m => m.name));
  for (const m of targets('matrix').filter(x => x.type !== 'Matrix' && !bgNames.has(x.name))) {
    // a non-matrix prop in "matrix visuals" is treated like a background prop
    if (sizeOf(m) === 'point') { if (!kickSet.has(m.name)) bars.forEach(b => pointPulse(m, 'matrix', b)); continue; }
    for (const run of stableRuns(bars)) {
      const s = run[0].section, v = pickFor(m, run[0].tier, s.type, themeOf(s), s.n + mk++ + seed * 3, 'background');
      if (v) push(m.name, 'matrix', run[0].start, run[run.length - 1].end, v.effect, lib.pace(v.effect, v.settings, paceOf(run[0])), paletteOf(s), brightnessOf(run[0]));
    }
  }
  // Shaders from the show folder: "sometimes" puts one on about a third of the matrix's
  // stretches, "often" on about two thirds; never twice in a row, and each idea picks others
  // how much of its picture a shader lights (measured in the browser); unknown counts as fine
  const lightOf = x => (typeof x.light === 'number' ? x.light : 0.6);
  const shaderList = (opts.shaders || []).filter(x => x.usable && lightOf(x) >= 0.2);
  const canvasShaders = shaderList.filter(x => lightOf(x) >= 0.5);
  let canvasTurn = seed * 5;
  const nextCanvasShader = () => canvasShaders.length ? canvasShaders[(canvasTurn++) % canvasShaders.length] : null;
  const shaderShare = { never: 0, sometimes: 0.35, often: 0.7 }[opts.shaderAmount || 'sometimes'] ?? 0.35;
  const shadersUsed = new Set();
  let shaderTurn = seed * 7, runNo = 0;
  const hashRun = n => { const x = Math.sin((n + 1) * 12.9898 + seed * 78.233) * 43758.5453; return x - Math.floor(x); };
  const useShader = () => shaderList.length > 0 && hashRun(runNo++) < shaderShare && lastLookIsNotShader();
  let lastLook = null;
  const lastLookIsNotShader = () => lastLook !== 'Shader';
  const nextShader = () => shaderList[(shaderTurn++) % shaderList.length];
  for (const m of targets('matrix').filter(x => x.type === 'Matrix')) {
    // One look per stretch, played straight through (the singing face sits on top with its
    // black see-through, so the look isn't cut up or restarted around every sung line).
    lastLook = null;
    for (const run of stableRuns(bars)) {
      const s = run[0].section, tier = run[0].tier, [c1, c2] = colorsOf(s);
      const start = run[0].start, end = run[run.length - 1].end;
      if (tier === 'high' || (tier === 'mid' && s.type === 'chorus')) {
        const marks = (tier === 'high' ? beats : downbeats).filter(t => t >= start - 0.02 && t < end);
        // the look decides the matrix's beat move (a ring, a spin, a climb...), alternating by section
        const alt = (s.n + seed) % 2 === 1;
        marks.forEach((t, i) => {
          const fx = familyMove('matrix', alt, i, Math.floor(i / 4) % 2 === 1, look.moves);
          push(m.name, 'matrix', t, marks[i + 1] ?? end, fx.effect, fx.settings, [i % 2 ? c2 : c1, C.white], 100);
        });
      } else if (useShader(m, run)) {               // one of your own shaders from the show folder
        const sh = nextShader();
        push(m.name, 'matrix', start, end, 'Shader', {
          E_0FILEPICKERCTRL_IFS: sh.file,                // relative to the show folder, like xLights saves it
          E_SLIDER_Shader_Speed: shaderSpeed(run[0]),
          E_TEXTCTRL_Shader_Zoom: 0, E_TEXTCTRL_Shader_Offset_X: 0, E_TEXTCTRL_Shader_Offset_Y: 0,
        }, paletteOf(s), tier === 'mid' ? 92 : 80);
        lastLook = 'Shader';
        shadersUsed.add(sh.name || sh.file);
      } else {                                      // low / mid / calm: a moving preset suited to a matrix
        const v = lib.pick({ model: m, tier, section: s.type, theme: themeOf(s), role: 'matrix', seed: s.n + mk++ + seed * 3,
          exclude: ['On', 'Fireworks', 'Fill', 'Strobe', 'Color Wash', lastLook].filter(Boolean) });
        if (v) lastLook = v.effect;                 // the next stretch gets a different effect
        // never slower than normal on the matrix: a crawling preset reads as a still picture
        if (v) push(m.name, 'matrix', start, end, v.effect, lib.pace(v.effect, v.settings, Math.max(1, paceOf(run[0]))),
          paletteOf(s), tier === 'mid' ? 92 : 80);
      }
    }
  }

  // ---------------------------------------------------------- whole-display shaders
  // A shader on a GROUP plays across all its props as one picture (xLights renders the
  // group as one canvas laid over where the props are). Used at the big moments: the
  // first two bars of every chorus, and with "often" also instrumental stretches
  // (4–16 bars with no singing). The props' own effects make way while it plays.
  const canvasGroups = (roles.canvas || []).filter(n => layout.groups.some(g => g.name === n));
  const canvasWindows = [];
  if (canvasGroups.length && canvasShaders.length && shaderShare > 0) {
    const spansV = vocalSpans(a.phrases || []);
    const sung = (t0, t1) => spansV.some(v => v.start < t1 && v.end > t0);
    for (const sec of sections.filter(x => x.type === 'chorus')) {
      const bs = bars.filter(b => b.section === sec);
      if (bs.length >= 2) canvasWindows.push([bs[0].start, bs[1].end]);
    }
    if (opts.shaderAmount === 'often') {
      for (const run of stableRuns(bars)) {
        const t0 = run[0].start, t1 = run[Math.min(run.length, 16) - 1].end;
        if (run.length >= 4 && run[0].tier !== 'low' && !sung(t0, t1)) canvasWindows.push([t0, t1]);
      }
    }
    canvasWindows.sort((x, y) => x[0] - y[0]);
    const kept = [];
    for (const w of canvasWindows) if (!kept.length || w[0] >= kept[kept.length - 1][1]) kept.push(w);
    canvasWindows.length = 0; canvasWindows.push(...kept);
    // One group per moment, taking turns: groups that overlap (Everything and Roof) would
    // otherwise paint the same props with two different pictures at once.
    canvasWindows.forEach((w, wi) => { w.group = canvasGroups[(wi + seed) % canvasGroups.length]; });
    for (const w of canvasWindows) {
      const [t0, t1] = w;
      const sh = nextCanvasShader();
      const b = bars.find(x => x.start >= t0 - 0.05) || bars[0];
      for (const g of [w.group]) {
        push(g, 'canvas', t0, t1, 'Shader', {
          E_0FILEPICKERCTRL_IFS: sh.file, B_CHOICE_BufferStyle: 'Per Preview',
          E_SLIDER_Shader_Speed: shaderSpeed(b),
          E_TEXTCTRL_Shader_Zoom: 0, E_TEXTCTRL_Shader_Offset_X: 0, E_TEXTCTRL_Shader_Offset_Y: 0,
        }, paletteOf(b.section), 100);
      }
      shadersUsed.add(sh.name || sh.file);
    }
  }
  out.canvasMoments = canvasWindows.length;

  out.shadersUsed = [...shadersUsed];

  // ---------------------------------------------------------- builds, held breath, landing
  // the two bars before a lift ramp up, the house goes dark for 1.5 beats, and the
  // new part lands with a flash on everything
  const house = [...new Set([...targets('background'), ...targets('kick'), ...targets('snare'), ...targets('crash')])]
    .filter(m => m.type !== 'Matrix');
  const breaths = [];
  for (const L of lifts) {
    const breathStart = L.at - 1.5 * beatLen;
    const [c1, c2] = colorsOf(L.section);
    // build: everything that carries the beat swells together, faster each beat
    beats.filter(t => t >= L.buildFrom && t < breathStart - 0.05).forEach((t, i, arr) => {
      const rise = Math.round(45 + 55 * (i / Math.max(1, arr.length - 1)));
      push2([...targets('kick'), ...targets('snare')], 'build', t, Math.min(t + beatLen * 0.5, breathStart), 'On', pulse(0),
        [i % 2 ? c2 : c1], rise);
    });
    for (const m of targets('bars').filter(x => (x.nodes || 1) > 80)) {   // a build chase only makes sense on a long prop
      push(m.name, 'build', L.buildFrom, breathStart, 'Single Strand', {
        E_CHOICE_Chase_Type1: 'Dual Bounce', E_TEXTCTRL_Chase_Rotations: Math.max(2, (breathStart - L.buildFrom) / beatLen).toFixed(1),
        E_SLIDER_Color_Mix1: 15, E_CHOICE_Fade_Type: 'Head and Tail' }, [c1, c2], 100);
    }
    breaths.push([breathStart, L.at]);
    push2(house, 'land', L.at, L.at + beatLen * 1.2, 'On', pulse(0), [C.white], 100);
  }

  // vocal accents: the strongest sung moments get a whole-house hit (the only time the
  // house breaks from the beat). About one per 20 seconds, never closer than 8 s.
  const accents = vocalAccents(a, bars, Math.max(3, Math.round(a.duration / 22)));
  for (const t of accents) {
    if (lifts.some(L => Math.abs(L.at - t) < 4)) continue;
    const b = bars.find(x => t >= x.start && t < x.end);
    const [c1] = b ? barColors(b) : [C.white];
    push2(house, 'land', t, t + beatLen, 'On', pulse(0), [C.white], 100);
    for (const m of targets('matrix').filter(x => x.type === 'Matrix')) {
      push(m.name, 'land', t, t + beatLen * 1.5, 'Shockwave', {
        E_SLIDER_Shockwave_Start_Radius: 1, E_SLIDER_Shockwave_End_Radius: 150, E_SLIDER_Shockwave_Start_Width: 10,
        E_SLIDER_Shockwave_End_Width: 30, E_CHECKBOX_Shockwave_Blend_Edges: 1 }, [C.white, c1], 100);
    }
  }
  out.accents = accents.length;

  // ---------------------------------------------------------- prop families (big moments)
  // From x-onset's mined pro sequences: in the big bars, each set of matching props
  // (all the trees, all the stars, all the arches...) drops its wash and moves
  // together on every beat — one motion per beat, one vivid colour every 4 beats,
  // a different colour per family. Verses keep their washes, so choruses read bigger.
  {
    const indoorF = new Set(opts.indoor || []);
    const busy = new Set([...targets('kick'), ...targets('snare'), ...targets('matrix'), ...targets('vocals')].map(m => m.name));
    const pool = [...new Set([...targets('background'), ...targets('bars'), ...targets('crash'), ...targets('toms')])]
      .filter(m => !busy.has(m.name) && !indoorF.has(m.name) && m.type !== 'Matrix' && sizeOf(m) !== 'point');
    const famKey = m => /tree/i.test(m.type) || /tree/i.test(m.name) ? 'tree' : m.type === 'Star' || /star|flake/i.test(m.name) ? 'star'
      : /arch/i.test(m.type + m.name) ? 'arch' : /cane/i.test(m.type + m.name) ? 'cane' : /icicle/i.test(m.type + m.name) ? 'icicle'
      : m.name.replace(/^(left|right|top|bottom|lg|large|sm|small|med|medium|mini|big)\s+/i, '').replace(/[\s_-]*\d+$|\s+[a-z]$/i, '').trim().toLowerCase();
    const fams = new Map();
    for (const m of pool) { const k = famKey(m); if (!fams.has(k)) fams.set(k, []); fams.get(k).push(m); }
    const families = [...fams.entries()].filter(([k, list]) => list.length >= 2 || (list.length === 1 && (k === 'tree' || k === 'star') && (list[0].nodes || 0) > 150));
    const hit = b => b.tier === 'high' || (b.section.type === 'chorus' && b.tier === 'mid' && !slowSong);
    const big = bars.filter(hit);
    const famOcc = {};
    let famBars = 0;
    for (const sec of runs(big, b => b.section)) {
      const s = sec[0].section;
      for (const [fi, [key, members]] of families.entries()) {
        const occ = famOcc[key] = (famOcc[key] ?? -1) + 1;
        const alt = (occ + seed) % 2 === 1;                   // every other big section uses the family's second move
        const vivid = vividColors(paletteOf(s).concat(colorsOf(s)));
        const off = crc(key) + occ;                           // each family starts on a different colour
        const t0 = sec[0].start, t1 = sec[sec.length - 1].end;
        silenceRoles(out, new Set(members.map(m => m.name)), ['background', 'bars', 'gapfill'], t0, t1);
        const bts = sec.flatMap(b => b.beats);
        bts.forEach((t, i) => {
          const nb = bts[i + 1] ?? Math.min(t + beatLen, t1);
          const end = Math.min(nb, t1);
          const color = vivid[(off + Math.floor(i / 4)) % vivid.length];
          const flip = Math.floor(i / 4) % 2 === 1;           // expand ↔ collapse, left ↔ right every 4 beats
          const fx = familyMove(key, alt, i, flip, look.moves);
          push2(members, 'family', t, end, fx.effect, fx.settings, [color], brightnessOf(sec[0]));
        });
      }
      famBars += sec.length;
    }
    out.look = { name: look.name, colors: look.colors, core: look.core, generated: !!themeOf(sections[0]).generated };
    out.families = families.map(([k, l]) => `${k} (${l.length})`);
    out.familyBars = famBars;
  }

  // ---------------------------------------------------------- lyric cues
  // the house acts out words in the lyrics: colours, fire, lightning, the moon...
  const cues = opts.lyricCues === false ? [] : findCues(a.words, a.phrases, beatLen, { show: opts.showKind });
  const floods = targets('kick'), hands = targets('snare'), roof = [...new Set([...targets('background'), ...targets('bars')])]
    .filter(m => m.type !== 'Matrix');
  const mtx = [...targets('matrix'), ...targets('vocals')].filter((m, i, l) => m.type === 'Matrix' && l.findIndex(x => x.name === m.name) === i);
  const everyone = [...new Set([...house, ...floods, ...hands, ...roof])];
  // Reactions take the whole house over (top layers), so a word can't get lost under
  // the beat: 'lyric' is a solid base, 'lyric-top' a moving layer over it.
  const solid = (props, t, end, color, from = 100, to = 60) =>
    push2(props, 'lyric', t, end, 'On', { E_TEXTCTRL_Eff_On_Start: from, E_TEXTCTRL_Eff_On_End: to }, [color], 100);
  // Christmas helpers: props by shape, house left to right, beat steps inside a cue
  const XR = '#FF0000', XG = '#00D020', XGOLD = '#FFB000';
  const trees = everyone.filter(m => m.type === 'Tree' || /tree/i.test(m.name));
  const stars = everyone.filter(m => m.type === 'Star' || /star/i.test(m.name));
  const canes = everyone.filter(m => /cane/i.test(m.name));
  const sorted = everyone.slice().sort((x, y) => (x.x ?? x.cx ?? 0) - (y.x ?? y.cx ?? 0));
  const beatsIn = (t0, t1) => {
    const bs = beats.filter(b => b > t0 + 0.05 && b < t1 - 0.05);
    const edges = [t0, ...bs, t1];
    return edges.slice(0, -1).map((b, i) => [b, edges[i + 1]]).filter(([b0, b1]) => b1 - b0 > 0.05);
  };
  for (const c of cues) {
    const { start: t, end } = c;
    switch (c.kind) {
      case 'color':                                   // the whole house turns that colour
        solid(everyone, t, end, c.color, 100, 55);
        push2(mtx, 'matrix-lyric', t, end, 'Color Wash', { E_TEXTCTRL_ColorWash_Cycles: '1.0' }, [c.color, c.color], 100);
        break;
      case 'moon':                                    // moonlight: cool white house, twinkling roof, a moon on the matrix
        solid(everyone, t, end, '#C8D8FF', 100, 45);
        push2(roof.filter(m => (m.nodes || 1) > 4), 'lyric-top', t, end, 'Twinkle', { E_SLIDER_Twinkle_Count: 40, E_SLIDER_Twinkle_Steps: 30 }, ['#FFFFFF'], 100);
        push2(mtx, 'matrix-lyric', t, end, 'Shockwave', { E_SLIDER_Shockwave_Start_Radius: 1, E_SLIDER_Shockwave_End_Radius: 30,
          E_SLIDER_Shockwave_Start_Width: 60, E_SLIDER_Shockwave_End_Width: 60, E_CHECKBOX_Shockwave_Blend_Edges: 1 }, ['#F4F7FF'], 100);
        break;
      case 'fire':
        push2(roof.filter(m => (m.nodes || 1) > 4), 'lyric', t, end, 'Fire', { E_SLIDER_Fire_Height: 90, E_SLIDER_Fire_HueShift: 0 }, ['#FF3000'], 100);
        push2([...floods, ...hands, ...roof.filter(m => (m.nodes || 1) <= 4)], 'lyric', t, end, 'On',
          { E_TEXTCTRL_Eff_On_Start: 100, E_TEXTCTRL_Eff_On_End: 50, E_CHECKBOX_On_Shimmer: 1 }, ['#FF4000'], 100);
        push2(mtx, 'matrix-lyric', t, end, 'Fire', { E_SLIDER_Fire_Height: 80, E_CHOICE_Fire_Location: 'Bottom' }, ['#FF3000'], 100);
        break;
      case 'strobe':
        push2(everyone, 'lyric', t, end, 'Strobe', { E_SLIDER_Number_Strobes: 4, E_SLIDER_Strobe_Duration: 6, E_SLIDER_Strobe_Type: 1 }, [C.white], 100);
        push2(mtx, 'matrix-lyric', t, end, 'Strobe', { E_SLIDER_Number_Strobes: 4, E_SLIDER_Strobe_Duration: 6, E_SLIDER_Strobe_Type: 1 }, [C.white], 100);
        break;
      case 'burst':                                   // "bark!", "scream!": everything flashes white and fades
        solid(everyone, t, end, C.white, 100, 0);
        if (hands[0]?.type === 'Star') push2(hands, 'lyric-top', t, end, 'Ripple', { E_CHOICE_Ripple_Object_To_Draw: 'Star',
          E_CHOICE_Ripple_Movement: 'Explode', E_SLIDER_Ripple_Thickness: 3, E_TEXTCTRL_Ripple_Cycles: '1.0' }, [C.white], 100);
        push2(mtx, 'matrix-lyric', t, end, 'Shockwave', { E_SLIDER_Shockwave_Start_Radius: 1, E_SLIDER_Shockwave_End_Radius: 150,
          E_SLIDER_Shockwave_Start_Width: 15, E_SLIDER_Shockwave_End_Width: 40, E_CHECKBOX_Shockwave_Blend_Edges: 1 }, [C.white], 100);
        break;
      case 'ghost':
        solid(everyone, t, end, '#E8F0FF', 70, 20);
        push2(roof.filter(m => (m.nodes || 1) > 4), 'lyric-top', t, end, 'Twinkle', { E_SLIDER_Twinkle_Count: 35, E_SLIDER_Twinkle_Steps: 60 }, [C.white], 100);
        break;
      case 'bright':
        solid(everyone, t, end, C.white, 100, 30);
        break;
      case 'dark':
        breaths.push([t, end]);                       // the house goes dark on the word
        break;

      // ---- Christmas words
      case 'redgreen': {                              // "lights": red and green trade places on every beat
        const steps = beatsIn(t, end);
        sorted.forEach((m, i) => steps.forEach(([b0, b1], k) =>
          push(m.name, 'lyric', b0, b1, 'On', { E_TEXTCTRL_Eff_On_Start: 100, E_TEXTCTRL_Eff_On_End: 70 }, [(i + k) % 2 ? XR : XG], 100)));
        push2(trees, 'lyric-top', t, end, 'Twinkle', { E_SLIDER_Twinkle_Count: 25, E_SLIDER_Twinkle_Steps: 20 }, [C.white], 100);
        push2(mtx, 'matrix-lyric', t, end, 'Bars', { E_SLIDER_Bars_BarCount: 2, E_CHOICE_Bars_Direction: 'Left', E_SLIDER_Bars_Cycles: Math.max(1, steps.length / 2) }, [XR, XG], 100);
        break;
      }
      case 'snow':                                    // cool white house with snow falling down the big props
        solid(everyone, t, end, '#B8CCFF', 70, 40);
        push2([...trees, ...canes, ...roof.filter(m => (m.nodes || 1) > 4)], 'lyric-top', t, end, 'Meteors',
          { E_SLIDER_Meteors_Count: 12, E_SLIDER_Meteors_Length: 20, E_SLIDER_Meteors_Speed: 8, E_CHOICE_Meteors_Effect: 'Down',
            E_CHOICE_Meteors_Type: 'Palette' }, [C.white], 100);
        push2(mtx, 'matrix-lyric', t, end, 'Meteors', { E_SLIDER_Meteors_Count: 15, E_SLIDER_Meteors_Length: 15, E_SLIDER_Meteors_Speed: 6,
          E_CHOICE_Meteors_Effect: 'Down', E_CHOICE_Meteors_Type: 'Palette' }, [C.white], 100);
        break;
      case 'star':                                    // the stars burst gold, everything else glows warm
        solid(everyone.filter(m => !stars.includes(m)), t, end, '#FFB040', 60, 30);
        solid(stars, t, end, XGOLD, 100, 70);
        push2(stars, 'lyric-top', t, end, 'Ripple', { E_CHOICE_Ripple_Object_To_Draw: 'Star', E_CHOICE_Ripple_Movement: 'Explode',
          E_SLIDER_Ripple_Thickness: 3, E_TEXTCTRL_Ripple_Cycles: '1.0' }, [C.white], 100);
        push2(mtx, 'matrix-lyric', t, end, 'Shockwave', { E_SLIDER_Shockwave_Start_Radius: 1, E_SLIDER_Shockwave_End_Radius: 120,
          E_SLIDER_Shockwave_Start_Width: 20, E_SLIDER_Shockwave_End_Width: 50, E_CHECKBOX_Shockwave_Blend_Edges: 1 }, [XGOLD], 100);
        break;
      case 'tree':                                    // the trees go green with twinkling ornaments; the rest a soft green
        solid(everyone.filter(m => !trees.includes(m)), t, end, XG, 55, 30);
        solid(trees.length ? trees : everyone, t, end, XG, 100, 85);
        push2(trees, 'lyric-top', t, end, 'Twinkle', { E_SLIDER_Twinkle_Count: 30, E_SLIDER_Twinkle_Steps: 25 }, [XR, XGOLD, C.white, '#0050FF'], 100);
        push2(mtx, 'matrix-lyric', t, end, 'Color Wash', { E_TEXTCTRL_ColorWash_Cycles: '1.0' }, [XG, XG], 100);
        break;
      case 'cane':                                    // red and white stripes climb the canes and run along the roof
        solid(everyone, t, end, XR, 70, 50);
        push2(canes.length ? canes : roof, 'lyric-top', t, end, 'Bars', { E_SLIDER_Bars_BarCount: 3, E_CHOICE_Bars_Direction: 'up',
          E_SLIDER_Bars_Cycles: 2 }, [XR, C.white], 100);
        push2(roof.filter(m => (m.nodes || 1) > 4 && !canes.includes(m)), 'lyric-top', t, end, 'Bars', { E_SLIDER_Bars_BarCount: 6,
          E_CHOICE_Bars_Direction: 'Left', E_SLIDER_Bars_Cycles: 2 }, [XR, C.white], 100);
        push2(mtx, 'matrix-lyric', t, end, 'Bars', { E_SLIDER_Bars_BarCount: 4, E_CHOICE_Bars_Direction: 'up', E_SLIDER_Bars_Cycles: 2 }, [XR, C.white], 100);
        break;
      case 'jingle':                                  // sleigh bells: gold and white sparkle everywhere
        solid(everyone, t, end, '#FFD890', 60, 30);
        push2(everyone.filter(m => (m.nodes || 1) > 4), 'lyric-top', t, end, 'Twinkle', { E_SLIDER_Twinkle_Count: 45, E_SLIDER_Twinkle_Steps: 8 }, [XGOLD, C.white], 100);
        for (const [b0] of beatsIn(t, end)) push2(floods, 'lyric-top', b0, b0 + beatLen / 2, 'On', pulse(0), [C.white], 100);
        push2(mtx, 'matrix-lyric', t, end, 'Twinkle', { E_SLIDER_Twinkle_Count: 30, E_SLIDER_Twinkle_Steps: 8 }, [XGOLD, C.white], 100);
        break;
      case 'hearth':                                  // a warm, crackling fireplace glow
        push2([...trees, ...roof.filter(m => (m.nodes || 1) > 4)], 'lyric', t, end, 'Fire', { E_SLIDER_Fire_Height: 45, E_SLIDER_Fire_HueShift: 8 }, ['#FF7000'], 100);
        push2(everyone.filter(m => !trees.includes(m) && !((m.nodes || 1) > 4 && roof.includes(m))), 'lyric', t, end, 'On',
          { E_TEXTCTRL_Eff_On_Start: 85, E_TEXTCTRL_Eff_On_End: 60, E_CHECKBOX_On_Shimmer: 1 }, ['#FF8A20'], 100);
        push2(mtx, 'matrix-lyric', t, end, 'Fire', { E_SLIDER_Fire_Height: 50, E_CHOICE_Fire_Location: 'Bottom', E_SLIDER_Fire_HueShift: 8 }, ['#FF7000'], 100);
        break;
      case 'gift': {                                  // presents: every prop pops its own colour and fades
        const wrap = [XR, XG, XGOLD, '#0050FF', '#FF40A0', C.white];
        sorted.forEach((m, i) => push(m.name, 'lyric', t, end, 'On', { E_TEXTCTRL_Eff_On_Start: 100, E_TEXTCTRL_Eff_On_End: 10 }, [wrap[i % wrap.length]], 100));
        push2(mtx, 'matrix-lyric', t, end, 'Shockwave', { E_SLIDER_Shockwave_Start_Radius: 1, E_SLIDER_Shockwave_End_Radius: 150,
          E_SLIDER_Shockwave_Start_Width: 15, E_SLIDER_Shockwave_End_Width: 40, E_CHECKBOX_Shockwave_Blend_Edges: 1 }, [XR, XG, XGOLD], 100);
        break;
      }
      case 'joy':                                     // a big white-gold flash that fades
        solid(everyone, t, end, '#FFF0C0', 100, 20);
        push2(stars, 'lyric-top', t, end, 'Ripple', { E_CHOICE_Ripple_Object_To_Draw: 'Star', E_CHOICE_Ripple_Movement: 'Explode',
          E_SLIDER_Ripple_Thickness: 3, E_TEXTCTRL_Ripple_Cycles: '1.0' }, [XGOLD], 100);
        push2(mtx, 'matrix-lyric', t, end, 'Shockwave', { E_SLIDER_Shockwave_Start_Radius: 1, E_SLIDER_Shockwave_End_Radius: 150,
          E_SLIDER_Shockwave_Start_Width: 15, E_SLIDER_Shockwave_End_Width: 40, E_CHECKBOX_Shockwave_Blend_Edges: 1 }, [C.white, XGOLD], 100);
        break;
      case 'hush':                                    // silent night: a soft, still glow (never a blackout)
        solid(everyone.filter(m => !stars.includes(m)), t, end, '#3050C0', 45, 25);
        solid(stars, t, end, '#FFE0A0', 70, 60);
        push2(mtx, 'matrix-lyric', t, end, 'Color Wash', { E_TEXTCTRL_ColorWash_Cycles: '1.0' }, ['#203080', '#203080'], 70);
        break;
    }
  }
  out.cues = cues.map(c => ({ t: +c.start.toFixed(2), word: c.word, kind: c.kind, color: c.color }));

  // held breath: cut everything on the house props for those 1.5 beats
  const houseNames = new Set(house.map(m => m.name));
  for (const [b0, b1] of breaths) silence(out, houseNames, b0, b1);
  // ...but outside never goes completely dark: the roof and the row of props keep a low
  // glow in the section colour through a held breath or a "shadows" word
  const indoor = new Set(opts.indoor || []);
  const glowProps = [...targets('background'), ...targets('bars'), ...targets('snare')]
    .filter((m, i, l) => l.findIndex(x => x.name === m.name) === i && !indoor.has(m.name) && (m.nodes || 1) > 4 && m.type !== 'Matrix');
  for (const [b0, b1] of breaths) {
    const b = bars.find(x => b0 >= x.start - 0.05 && b0 < x.end) || bars[0];
    if (b) push2(glowProps, 'build', b0, b1, 'On', steady, [colorsOf(b.section)[0]], 22);
  }

  // ---------------------------------------------------------- outdoor gap check
  // Indoor props (rack, TV stand, lamps) don't count: if only they are lit, nothing is
  // happening outside. Any stretch of 0.4 s or more where no outdoor prop is lit gets a
  // soft wash on the outdoor background props.
  {
    const FR = 0.05, songEnd = a.offStart || a.duration, n = Math.ceil(songEnd / FR);
    const lit = new Uint8Array(n);
    const levelOf = (e, t) => {
      if (e.effect === 'On') {
        const s0 = +(e.settings.E_TEXTCTRL_Eff_On_Start ?? 100), s1 = +(e.settings.E_TEXTCTRL_Eff_On_End ?? 100);
        return (s0 + (s1 - s0) * (t - e.start) / Math.max(1e-6, e.end - e.start)) / 100 * (e.brightness / 100);
      }
      return e.effect === 'Faces' ? 0.3 : 0.4 * (e.brightness / 100);
    };
    const outdoorNames = new Set(layout.models.filter(m => !indoor.has(m.name)).map(m => m.name));
    const outdoorGroups = new Set(layout.groups.filter(g => expand(layout, [g.name]).some(m => outdoorNames.has(m.name))).map(g => g.name));
    for (const e of out) {
      if (!outdoorNames.has(e.el) && !outdoorGroups.has(e.el)) continue;
      for (let i = Math.max(0, Math.floor(e.start / FR)); i < Math.min(n, Math.ceil(e.end / FR)); i++) {
        if (!lit[i] && levelOf(e, i * FR) > 0.08) lit[i] = 1;
      }
    }
    const fill = glowProps.length ? glowProps : targets('background').filter(m => !indoor.has(m.name));
    // from the first moment the song is audible (an intro line before the first bar counts)
    const audible = (a.energy || []).find(e => e.value > 0.05);
    const first = Math.min(bars[0]?.start ?? 0, audible ? audible.time : Infinity);
    let gaps = 0;
    for (let i = Math.ceil(first / FR); i < n;) {
      if (lit[i]) { i++; continue; }
      let j = i;
      while (j < n && !lit[j]) j++;
      if ((j - i) * FR >= 0.4) {
        const b = bars.find(x => i * FR >= x.start - 0.05 && i * FR < x.end) || (i * FR < bars[0].start ? bars[0] : bars[bars.length - 1]);
        push2(fill, 'gapfill', i * FR, j * FR, 'Color Wash', { E_TEXTCTRL_ColorWash_Cycles: '1.0' }, colorsOf(b.section), 45);
        gaps++;
      }
      i = j;
    }
    out.gapsFilled = gaps;
  }
  // During a whole-display moment the group's props drop their washes and matrix looks so
  // the shader is the picture, but keep their hits and glow: a shader with a lot of black in
  // it would otherwise leave the house dark.
  for (const w of canvasWindows) {
    const members = new Set(expand(layout, [w.group]).map(m => m.name));
    const yieldRoles = new Set(['background', 'matrix', 'bars']);
    const keep = out.filter(e => !(members.has(e.el) && yieldRoles.has(e.role)));
    const moved = out.filter(e => members.has(e.el) && yieldRoles.has(e.role));
    out.length = 0; out.push(...keep);
    silence(moved, members, w[0], w[1]);
    out.push(...moved);
  }

  finishLooks(out, { bars, beatLen, layout });

  // ending: whatever is lit at the end fades out with the song
  const songEnd = (a.offStart || a.duration);
  for (const e of out) {
    if (e.end >= songEnd - 0.3 && e.end - e.start > 2) {
      e.settings = { ...e.settings, T_TEXTCTRL_Fadeout: Math.min(4, (e.end - e.start) / 2).toFixed(2) };
    }
  }

  return out;

  function push2(props, role, start, end, effect, settings, colors, brightness) {
    props.forEach(m => push(m.name, role, start, end, effect, settings, colors, brightness));
  }
}

// ------------------------------------------------------------------ intensity

// Score every bar 0–1 against the rest of the same song, from how loud it is and
// how busy the drums are, then smooth it so tiers don't flicker bar to bar and
// lean it toward its section so a chorus reads as a chorus.
function scoreIntensity(a, bars, sections, slowSong) {
  const energy = a.energy || [];
  const hits = ['kick', 'snare', 'toms', 'hihat'].flatMap(k => a.drums?.[k] || []);
  for (const b of bars) {
    const ev = energy.filter(e => e.time >= b.start && e.time < b.end).map(e => e.value);
    b.loud = ev.length ? ev.reduce((x, y) => x + y, 0) / ev.length : 0;
    const n = hits.filter(h => h.time >= b.start && h.time < b.end).length;
    b.busy = n / Math.max(0.5, b.end - b.start);
    const k = (a.drums?.kick || []).filter(h => h.time >= b.start && h.time < b.end).length;
    const s = (a.drums?.snare || []).filter(h => h.time >= b.start && h.time < b.end).length;
    b.drums = k >= 2 || s >= 1;
  }
  // scale each measure between this song's 10th and 90th percentile bar; a measure
  // that barely changes through the song (spread < 15% of its typical value) counts
  // as flat and contributes nothing, so a steady song doesn't get invented contrast
  const scale = key => {
    const v = bars.map(b => b[key]).sort((x, y) => x - y);
    const q = f => v[Math.min(v.length - 1, Math.floor(f * v.length))] ?? 0;
    const lo = q(0.1), hi = q(0.9), med = q(0.5) || 1e-9;
    if ((hi - lo) / med < 0.15) return () => 0.5;
    return x => Math.max(0, Math.min(1, (x - lo) / (hi - lo)));
  };
  const rl = scale('loud'), rb = scale('busy');
  bars.forEach(b => { b.raw = (0.5 * rl(b.loud) + 0.5 * rb(b.busy)) * (b.drums ? 1 : 0.6); });
  bars.forEach((b, i) => {
    const p = bars[i - 1]?.raw ?? b.raw, n = bars[i + 1]?.raw ?? b.raw;
    b.smooth = 0.25 * p + 0.5 * b.raw + 0.25 * n;
  });
  for (const s of sections) {
    const inS = bars.filter(b => b.section === s);
    const mean = inS.reduce((x, b) => x + b.smooth, 0) / Math.max(1, inS.length);
    inS.forEach(b => { b.intensity = 0.5 * b.smooth + 0.5 * mean; });
  }
  // tiers by rank within the song: roughly the top third of bars are "high" and
  // the bottom quarter "low" — unless the song is flat throughout, then mostly mid
  const sorted = bars.map(b => b.intensity).sort((x, y) => x - y);
  const pct = q => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0.5;
  const spread = pct(0.9) - pct(0.1);
  const hiCut = spread < 0.12 ? Infinity : pct(TIER_THRESHOLDS.high);
  const loCut = spread < 0.12 ? -Infinity : pct(TIER_THRESHOLDS.low);
  for (const b of bars) {
    let tier = b.intensity >= hiCut ? 'high' : b.intensity < loCut ? 'low' : 'mid';
    if (slowSong) tier = tier === 'high' ? 'mid' : tier === 'low' ? 'calm' : 'mid';
    b.tier = tier;
  }
}

// Remove (or trim) every effect on these props between b0 and b1.
function silence(effects, names, b0, b1) {
  const extra = [];
  for (let i = effects.length - 1; i >= 0; i--) {
    const e = effects[i];
    if (!names.has(e.el) || e.role === 'land' || e.end <= b0 || e.start >= b1) continue;
    if (e.start < b0 && e.end > b1) {                 // spans the whole gap: split in two
      extra.push({ ...e, start: b1 });
      e.end = b0;
    } else if (e.start < b0) e.end = b0;
    else if (e.end > b1) e.start = b1;
    else effects.splice(i, 1);
  }
  effects.push(...extra);
}

// ------------------------------------------------------------------ finishing pass
// Ideas from x-onset (derwin12/xlights-autosequencer), learned from real renders:
//  - a long effect that moves one way gets boring: flip its direction every 4 bars
//  - guard rails for effects that look broken at their defaults
//  - washes fade in and out (scaled to their length), and cross-fade into the next look
const DEFAULT_FX = require('./library/defaults.json').defaults;
const FLIP = {
  E_CHOICE_Bars_Direction: { Left: 'Right', Right: 'Left', up: 'down', down: 'up', expand: 'compress', compress: 'expand' },
  E_CHOICE_Meteors_Effect: { Down: 'Up', Up: 'Down', Left: 'Right', Right: 'Left', Explode: 'Implode', Implode: 'Explode' },
  E_CHOICE_Wave_Direction: { 'Right to Left': 'Left to Right', 'Left to Right': 'Right to Left' },
  E_CHOICE_Chase_Type1: { 'Left-Right': 'Right-Left', 'Right-Left': 'Left-Right', 'From Middle': 'To Middle', 'To Middle': 'From Middle',
    'Bounce from Left': 'Bounce from Right', 'Bounce from Right': 'Bounce from Left' },
  E_CHOICE_Ripple_Movement: { Explode: 'Implode', Implode: 'Explode' },
  E_CHOICE_Fill_Direction: { Up: 'Down', Down: 'Up', Left: 'Right', Right: 'Left' },
  E_SLIDER_Spirals_Rotation: v => String(-Number(v)),
  E_CHECKBOX_Pinwheel_Rotation: v => (String(v) === '1' ? '0' : '1'),
};
const SUSTAINED = new Set(['background', 'matrix', 'gapfill', 'canvas']);
const FADE_STEPS = [0.25, 0.5, 0.75, 1, 1.5, 2];

function finishLooks(out, { bars, beatLen, layout }) {
  const tierAt = t => (bars.find(b => t >= b.start && t < b.end) || {}).tier || 'mid';
  const modelOf = new Map((layout.models || []).map(m => [m.name, m]));
  const barLen = 4 * beatLen;
  // 1. flip direction every other 4-bar block of a long one-way effect
  const added = [];
  for (const e of out) {
    if (!SUSTAINED.has(e.role) || e.end - e.start < 8 * barLen) continue;
    const all = { ...(DEFAULT_FX[e.effect] || {}), ...e.settings };
    const keys = Object.keys(FLIP).filter(k => all[k] !== undefined && (typeof FLIP[k] === 'function' || FLIP[k][all[k]]));
    if (!keys.length) continue;
    const cuts = bars.filter(b => b.start > e.start + barLen * 3.5 && b.start < e.end - barLen * 1.5).map(b => b.start)
      .filter((_, i) => i % 4 === 0);
    if (!cuts.length) continue;
    const edges = [e.start, ...cuts, e.end], end0 = e.end;
    e.end = edges[1]; e.joinNext = true;
    for (let i = 1; i + 1 < edges.length; i++) {
      const settings = { ...e.settings };
      if (i % 2) for (const k of keys) settings[k] = typeof FLIP[k] === 'function' ? FLIP[k](all[k]) : FLIP[k][all[k]];
      added.push({ ...e, settings, start: edges[i], end: i + 2 === edges.length ? end0 : edges[i + 1], joinPrev: true, joinNext: i + 2 < edges.length });
    }
  }
  out.push(...added);
  // 2. guard rails
  for (const e of out) {
    const s = e.settings = { ...e.settings }, all = { ...(DEFAULT_FX[e.effect] || {}), ...s };
    const tier = tierAt(e.start), m = modelOf.get(e.el);
    if (e.effect === 'Pinwheel') {
      if (!['3D', 'Sweep'].includes(all.E_CHOICE_Pinwheel_3D)) s.E_CHOICE_Pinwheel_3D = 'Sweep';
      const floor = m && (m.type === 'Tree' || /tree/i.test(m.name)) ? 50 : 5;
      if (Number(all.E_SLIDER_Pinwheel_Thickness) < floor) s.E_SLIDER_Pinwheel_Thickness = floor;
      if (SUSTAINED.has(e.role)) s.E_SLIDER_Pinwheel_Speed = tier === 'high' ? 22 : tier === 'mid' ? 13 : 6;
    }
    if (e.effect === 'Spirals') {
      const flags = ['3D', 'Blend', 'Grow', 'Shrink'].map(k => `E_CHECKBOX_Spirals_${k}`);
      if (flags.every(k => String(all[k] ?? '0') === '0')) flags.forEach(k => { s[k] = 1; });
      if (Number(all.E_SLIDER_Spirals_Thickness) < 1) s.E_SLIDER_Spirals_Thickness = 1;
    }
    if (e.effect === 'Wave') {
      if (Number(all.E_TEXTCTRL_Number_Waves) < 1) s.E_TEXTCTRL_Number_Waves = '1.00';
      if (Number(all.E_SLIDER_Thickness_Percentage) < 10) s.E_SLIDER_Thickness_Percentage = 10;
    }
    if (e.effect === 'Color Wash') s.E_CHECKBOX_ColorWash_Shimmer = 0;
  }
  // 3. fades on washes: none under 0.5 s; 8% (0.05–0.5 s) up to 4 s long; 10% (0.2–2 s) beyond;
  //    snapped to a step and never more than 20% of the effect. Where another look follows
  //    straight on, the hand-over is a one-beat cross-fade instead.
  const snap = f => FADE_STEPS.reduce((b, x) => (Math.abs(x - f) < Math.abs(b - f) ? x : b), FADE_STEPS[0]);
  const byKey = new Map();
  for (const e of out) if (SUSTAINED.has(e.role)) {
    const k = e.el + '|' + e.role;
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k).push(e);
  }
  for (const list of byKey.values()) {
    list.sort((x, y) => x.start - y.start);
    list.forEach((e, i) => {
      const d = e.end - e.start;
      if (d < 0.5) return;
      const cap = 0.2 * d;
      const own = Math.min(cap, snap(d <= 4 ? Math.max(0.05, Math.min(0.5, 0.08 * d)) : Math.max(0.2, Math.min(2, 0.1 * d))));
      const cross = Math.min(cap, snap(beatLen));
      const prev = list[i - 1], next = list[i + 1];
      const touchPrev = prev && Math.abs(prev.end - e.start) < 0.06, touchNext = next && Math.abs(next.start - e.end) < 0.06;
      const fin = e.joinPrev ? 0 : touchPrev ? (prev.effect === e.effect ? 0 : cross) : own;
      const fout = e.joinNext ? 0 : touchNext ? (next.effect === e.effect ? 0 : cross) : own;
      if (fin >= 0.05 && e.settings.T_TEXTCTRL_Fadein === undefined) e.settings.T_TEXTCTRL_Fadein = fin.toFixed(2);
      if (fout >= 0.05 && e.settings.T_TEXTCTRL_Fadeout === undefined) e.settings.T_TEXTCTRL_Fadeout = fout.toFixed(2);
    });
  }
  for (const e of out) { delete e.joinPrev; delete e.joinNext; }
}

// silence() for just some roles (a wash steps aside; hits on the same prop stay)
function silenceRoles(effects, names, roles, b0, b1) {
  const R = new Set(roles);
  const moved = effects.filter(e => R.has(e.role) && names.has(e.el));
  const keep = effects.filter(e => !(R.has(e.role) && names.has(e.el)));
  silence(moved, names, b0, b1);
  effects.length = 0; effects.push(...keep, ...moved);
}

// Strongest sung moments: the start of each sung line, scored by how loud the bar is and
// how long the line holds; the top N, spaced at least 8 s apart.
function vocalAccents(a, bars, n) {
  const loud = t => (bars.find(b => t >= b.start && t < b.end)?.intensity) ?? 0;
  const cands = (a.phrases || []).map(p => ({ t: p.start, score: loud(p.start) * Math.min(4, p.end - p.start) }))
    .filter(c => loud(c.t) > 0)
    .sort((x, y) => y.score - x.score);
  const chosen = [];
  for (const c of cands) {
    if (chosen.length >= n) break;
    if (chosen.every(t => Math.abs(t - c.t) >= 8)) chosen.push(c.t);
  }
  return chosen.sort((x, y) => x - y);
}

// Stretches of bars that keep one look. A look only changes at a section boundary, or
// inside a section when the intensity changes for at least 4 bars; shorter changes are
// absorbed, so the roof and matrix don't flip effects every couple of seconds.
function stableRuns(bars) {
  const out = [];
  for (const sec of runs(bars, b => b.section)) {
    const parts = runs(sec, b => b.tier);
    const merged = [];
    for (const p of parts) {
      if (merged.length && p.length < 4) merged[merged.length - 1].push(...p);
      else merged.push([...p]);
    }
    if (merged.length > 1 && merged[0].length < 4) { merged[1].unshift(...merged[0]); merged.shift(); }
    for (const m of merged) {
      // the run takes the tier most of its bars have
      const count = {};
      m.forEach(b => { count[b.tier] = (count[b.tier] || 0) + 1; });
      const tier = Object.keys(count).sort((x, y) => count[y] - count[x])[0];
      m.forEach(b => { b.runTier = tier; });
      out.push(m.map(b => ({ ...b, tier })));
    }
  }
  return out;
}

function runs(list, keyOf) {
  const out = [];
  for (const x of list) {
    const last = out[out.length - 1];
    if (last && keyOf(last[last.length - 1]) === keyOf(x) && Math.abs(last[last.length - 1].end - x.start) < 0.05) last.push(x);
    else out.push([x]);
  }
  return out;
}

function brighter([a, b]) {
  const lum = h => { const n = parseInt(h.slice(1), 16); return 0.3 * (n >> 16) + 0.59 * ((n >> 8) & 255) + 0.11 * (n & 255); };
  return lum(a) >= lum(b) ? a : b;
}

// short gaps between sung lines stay as gaps, so the matrix shows its visuals between lines
function vocalSpans(phrases, gap = 0.6) {
  const out = [];
  for (const p of phrases) {
    const last = out[out.length - 1];
    if (last && p.start - last.end < gap) last.end = Math.max(last.end, p.end);
    else out.push({ start: p.start, end: p.end });
  }
  return out;
}

function splitBySpans(start, end, spans) {
  const parts = [];
  let t = start;
  for (const v of spans) {
    if (v.end <= t || v.start >= end) continue;
    if (v.start > t) parts.push({ start: t, end: v.start, vocal: false });
    parts.push({ start: Math.max(t, v.start), end: Math.min(end, v.end), vocal: true });
    t = Math.min(end, v.end);
  }
  if (t < end) parts.push({ start: t, end, vocal: false });
  return parts.filter(p => p.end - p.start > 0.2);
}

// What a family of matching props does on each beat of a big moment (from x-onset's
// corpus recipes, mined from professional sequences). i = beat index, flip = every 4 beats.
function familyMove(key, alt, i, flip, moves) {
  const M = {
    burst: { effect: 'Shockwave', settings: { E_SLIDER_Shockwave_CenterX: 50, E_SLIDER_Shockwave_CenterY: 50,
      E_SLIDER_Shockwave_Start_Radius: flip ? 100 : 1, E_SLIDER_Shockwave_End_Radius: flip ? 1 : 100,
      E_SLIDER_Shockwave_Start_Width: flip ? 35 : 5, E_SLIDER_Shockwave_End_Width: flip ? 5 : 35, E_CHECKBOX_Shockwave_Blend_Edges: 1 } },
    chase: { effect: 'Single Strand', settings: { E_CHOICE_Chase_Type1: (i % 2) ^ flip ? 'Right-Left' : 'Left-Right',
      E_CHOICE_Fade_Type: 'From Head', E_SLIDER_Color_Mix1: 25, E_SLIDER_Number_Chases: 1, E_TEXTCTRL_Chase_Rotations: '1.0' } },
    bounce: { effect: 'Single Strand', settings: { E_CHOICE_Chase_Type1: flip ? 'To Middle' : 'From Middle',
      E_CHOICE_Fade_Type: 'Head and Tail', E_SLIDER_Color_Mix1: 30, E_SLIDER_Number_Chases: 1, E_TEXTCTRL_Chase_Rotations: '1.0' } },
    spiral: { effect: 'Spirals', settings: { E_SLIDER_Spirals_Count: 2, E_SLIDER_Spirals_Rotation: flip ? -20 : 20,
      E_SLIDER_Spirals_Thickness: 60, E_CHECKBOX_Spirals_3D: 1, E_CHECKBOX_Spirals_Blend: 1, E_TEXTCTRL_Spirals_Movement: '1.0',
      B_CHOICE_BufferTransform: i % 2 ? 'Flip Horizontal' : 'None' } },
    pinwheel: { effect: 'Pinwheel', settings: { E_SLIDER_Pinwheel_Arms: key === 'tree' ? 4 : 5, E_SLIDER_Pinwheel_Twist: 60,
      E_SLIDER_Pinwheel_Thickness: 50, E_SLIDER_Pinwheel_Speed: 22, E_CHOICE_Pinwheel_3D: 'Sweep', E_CHECKBOX_Pinwheel_Rotation: flip ? 0 : 1 } },
    climb: { effect: 'Bars', settings: { E_SLIDER_Bars_BarCount: 2, E_CHOICE_Bars_Direction: flip ? 'down' : 'up', E_SLIDER_Bars_Cycles: 1,
      E_CHECKBOX_Bars_Highlight: 1 } },
    bars: { effect: 'Bars', settings: { E_SLIDER_Bars_BarCount: 3, E_CHOICE_Bars_Direction: flip ? 'Right' : 'Left', E_SLIDER_Bars_Cycles: 1 } },
    rain: { effect: 'Meteors', settings: { E_SLIDER_Meteors_Count: 14, E_SLIDER_Meteors_Length: 30, E_SLIDER_Meteors_Speed: 25,
      E_CHOICE_Meteors_Effect: flip ? 'Up' : 'Down', E_CHOICE_Meteors_Type: 'Palette' } },
    ripple: { effect: 'Ripple', settings: { E_CHOICE_Ripple_Object_To_Draw: 'Star', E_CHOICE_Ripple_Movement: flip ? 'Implode' : 'Explode',
      E_SLIDER_Ripple_Thickness: 3, E_TEXTCTRL_Ripple_Cycles: '1.0' } },
    twinkle: { effect: 'Twinkle', settings: { E_SLIDER_Twinkle_Count: 60, E_SLIDER_Twinkle_Steps: 6 } },
    ring: { effect: 'Ripple', settings: { E_CHOICE_Ripple_Object_To_Draw: 'Circle', E_CHOICE_Ripple_Movement: flip ? 'Implode' : 'Explode',
      E_SLIDER_Ripple_Thickness: 6, E_TEXTCTRL_Ripple_Cycles: '1.0' } },
  };
  const group = key === 'tree' || key === 'matrix' ? key : key === 'star' ? 'star' : 'line';
  const pair = (moves && moves[group]) || { tree: ['burst', 'spiral'], star: ['burst', 'pinwheel'], line: ['chase', 'burst'], matrix: ['burst', 'ring'] }[group];
  return M[pair[alt ? 1 : 0]] || M.burst;
}

// x-onset's "vivid mask" colours: saturated colours pushed bright, at least 25° apart.
function vividColors(list) {
  const hsv = h => { const n = parseInt(h.slice(1), 16), r = (n >> 16) / 255, g = ((n >> 8) & 255) / 255, b = (n & 255) / 255;
    const mx = Math.max(r, g, b), d = mx - Math.min(r, g, b);
    const hue = d === 0 ? 0 : mx === r ? ((g - b) / d + 6) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
    return [hue * 60, mx ? d / mx : 0, mx]; };
  const hex = (H, S, V) => { const f = k => { const x = (k + H / 60) % 6; return V - V * S * Math.max(0, Math.min(x, 4 - x, 1)); };
    return '#' + [f(5), f(3), f(1)].map(v => Math.round(v * 255).toString(16).padStart(2, '0')).join('').toUpperCase(); };
  const picked = [];
  for (const c of list) {
    if (!/^#[0-9a-f]{6}$/i.test(c || '')) continue;
    const [H, S] = hsv(c);
    if (S < 0.25) continue;
    if (picked.some(([h]) => Math.min(Math.abs(h - H), 360 - Math.abs(h - H)) < 25)) continue;
    picked.push([H, Math.max(S, 0.75)]);
  }
  if (!picked.length) return [C.white];
  const base = picked[0];
  // too few colours: add near neighbours of the main one (full brightness: dimmed yellows go olive)
  for (const dh of [30, -30]) if (picked.length < 3) picked.push([(base[0] + dh + 360) % 360, 0.9]);
  return picked.map(([H, S]) => hex(H, S, 1));
}

function crc(str) { let h = 0; for (const ch of str) h = (h * 31 + ch.charCodeAt(0)) >>> 0; return h % 97; }

module.exports = { build, C };
