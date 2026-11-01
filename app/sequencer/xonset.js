// The x-onset sequencing engine, ported from derwin12/xlights-autosequencer (MIT).
//
// How it sequences (src/generator/plan.py + effect_placer.py + rotation.py there):
//
//  1. Power groups from the layout: BASE (everything), GEO (left/centre/right and
//     top/mid/bottom thirds), BEAT (4 groups, each kind of prop dealt round-robin),
//     PROP (every kind of prop with 2+ of them: all the trees, all the canes...) and
//     HERO (the biggest props, faces, mega trees, toppers).
//  2. Every section gets an energy 0–100 (rescaled within the song) and a mood:
//     ethereal (≤33), structural (≤66) or aggressive. A chorus is never ethereal.
//  3. A theme per section from x-onset's 28 themes, by mood and occasion (Halloween,
//     Christmas, general): the same section label reuses its theme, neighbours differ.
//     Each theme is 1–3 layers of tuned effect presets, with alternates for repeats.
//  4. Which tiers play: ethereal = BASE + HERO; structural = BASE + GEO call-and-
//     response (when the music repeats in 4-bar phrases) or BASE + PROP; aggressive =
//     BASE + BEAT chase + PROP + HERO. Quieter sections light fewer PROP groups
//     (40% / 70% / 100%).
//  5. A rotation plan picks a preset for every PROP and HERO group in every section by
//     score (prop type 0.30, energy 0.25, tier 0.20, section role 0.15, scope, genre),
//     penalising a repeat of the same section label, never giving two groups in a tier
//     the same effect, and never letting one effect take over a quarter of the song.
//  6. Placement: BASE is one sustained dim wash (lightness 0.40) with sparkles; GEO
//     answers left/top against right/bottom every 4 bars; BEAT chases the 4 groups one
//     beat each, forward while the music builds and backward as it falls; PROP and HERO
//     play their preset, cut to a length set by tempo and energy, with fades scaled to
//     length and directions alternating. Matching props (trees, stars, arches, canes,
//     icicles, lines) in choruses/high energy use the mined "corpus recipe": a motion
//     on every beat with a vivid colour every 4 beats.
//  7. Accents: drum hits on small stars/spinners (kick ring, snare flash, hi-hat
//     strobe) when energy ≥ 60; an impact ring at the start of big choruses; crash
//     swells (at most 12, 3 s apart, never over singing); star bursts on drum fills;
//     hi-hat ticks and kick rolls on the floods, one flood at a time; extra whole-house
//     layers in loud sections.
//
// Deliberate differences: effects go on each prop (xLights "Per Model", which is what
// x-onset uses for tiers 4+); floods stay dark unless hitting (your rule); the song's
// colour identity comes from its generated look (look.js) instead of being averaged
// from the themes, so every song and every "another look" gets its own palette.
const lib = require('./library');
const X = require('./library/xonset.json');
const DEFAULTS = require('./library/defaults.json').defaults;
const variants = require('./library/variants.json').variants;

const byVariant = new Map(variants.map(v => [v.name, v]));
const THEMES = X.themes;
const EFFECTS = X.effects;
const NEVER = new Set(['Liquid', 'Warp', 'Kaleidoscope', 'Tendril', 'Shape', 'Fan', 'Fireworks', 'Shader', 'Marquee', 'Fill',
  'VU Meter', 'Music', 'Text', 'Pictures', 'Video', 'Faces', 'Tree', 'Lightning']);
const usable = v => v && !NEVER.has(v.effect) && (DEFAULTS[v.effect] || ['On', 'Off', 'Strobe'].includes(v.effect));

const TIER_CAP = { 1: 3, 2: 3, 3: 4, 4: 3, 5: 4, 6: 4, 7: 6, 8: 6 };
const BLOCKY_BOX = new Set(['Bars', 'Curtain', 'Single Strand']);
const BOX_SAFE = ['Plasma', 'Spirals', 'Galaxy', 'Ripple', 'Color Wash'];
const MATRIX_LOW = new Set(['Bars', 'Single Strand', 'Strobe', 'Curtain']);
const MATRIX_OK = ['Plasma', 'Fire', 'Pinwheel', 'Spirals', 'Shockwave', 'Galaxy'];
const DENSE = new Set(['Color Wash', 'Liquid', 'Plasma', 'Fire', 'Galaxy', 'Pinwheel', 'Butterfly', 'Shockwave']);
const ALT_DIR = {
  E_CHOICE_Bars_Direction: ['Left', 'Right', 'expand', 'compress'],
  E_SLIDER_Spirals_Rotation: ['20', '-20'],
  E_CHOICE_Meteors_Effect: ['Down', 'Up', 'Left', 'Right'],
  E_CHOICE_Curtain_Effect: ['open', 'close', 'open then close', 'close then open'],
  E_CHOICE_Wave_Direction: ['Right to Left', 'Left to Right'],
  E_CHOICE_Ripple_Movement: ['Explode', 'Implode'],
  E_CHOICE_Fire_Location: ['Bottom', 'Top', 'Left', 'Right'],
};
const FORCE = { Butterfly: { E_CHOICE_Butterfly_Colors: 'Palette' }, Meteors: { E_CHOICE_Meteors_Type: 'Palette' } };
const FADE_STEPS = [250, 500, 750, 1000, 1500, 2000];
const RADIAL_WORDS = /spinner|flake|snowflake|wreath|star|circle|spiral/i;
const RECIPE = [                                          // corpus recipe families, by name token
  ['snowflake', /snow\s*flake/i], ['arch', /arch/i], ['tree', /tree/i], ['cane', /cane/i],
  ['icicle', /icicle/i], ['star', /star/i], ['line', /lines?$|roof|eave|gutter|outline/i],
];

// ------------------------------------------------------------------ small helpers
function crc(str) {                                       // CRC-32, as x-onset breaks ties with zlib.crc32
  let c, crcv = 0xFFFFFFFF;
  for (let n = 0; n < str.length; n++) {
    c = (crcv ^ str.charCodeAt(n)) & 0xFF;
    for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xEDB88320 : c >>> 1;
    crcv = (crcv >>> 8) ^ c;
  }
  return (crcv ^ 0xFFFFFFFF) >>> 0;
}
const toHsl = hex => {
  const n = parseInt(hex.slice(1), 16), r = (n >> 16) / 255, g = ((n >> 8) & 255) / 255, b = (n & 255) / 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2, d = mx - mn;
  const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
  let h = d === 0 ? 0 : mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [((h * 60) + 360) % 360, s, l];
};
const fromHsl = (h, s, l) => {
  const c = (1 - Math.abs(2 * l - 1)) * s, x = c * (1 - Math.abs(((h / 60) % 2) - 1)), m = l - c / 2;
  const [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  return '#' + [r, g, b].map(v => Math.round((v + m) * 255).toString(16).padStart(2, '0')).join('').toUpperCase();
};
const saturated = pal => pal.filter(c => toHsl(c)[1] >= 0.25 && toHsl(c)[2] > 0.08 && toHsl(c)[2] < 0.92);
const darken = (pal, L) => pal.map(c => { const [h, s] = toHsl(c); return fromHsl(h, s, L); });
const lighten = (pal, amt) => pal.map(c => { const [h, s, l] = toHsl(c); return fromHsl(h, s, l + (1 - l) * amt); });
// rotate each colour's hue toward the anchor's (shortest way round), keeping its own saturation/lightness
const blendHue = (pal, anchor, w) => pal.map((c, i) => {
  const [h, s, l] = toHsl(c), [ha] = toHsl(anchor[i % anchor.length]);
  let d = ha - h; if (d > 180) d -= 360; if (d < -180) d += 360;
  return fromHsl((h + d * w + 360) % 360, s, l);
});
// x-onset's palette restraint: min(2 + energy//33, tier cap) colours, spread across the palette
const restrain = (pal, energy, tier) => {
  const n = Math.max(1, Math.min(2 + Math.floor(energy / 33), TIER_CAP[tier] || 4, pal.length));
  if (n >= pal.length) return pal.slice();
  return Array.from({ length: n }, (_, i) => pal[Math.floor(i * pal.length / n)]);
};
const pearson = (a, b) => {
  const n = a.length; if (n < 2) return 0;
  const ma = a.reduce((x, y) => x + y, 0) / n, mb = b.reduce((x, y) => x + y, 0) / n;
  let sab = 0, saa = 0, sbb = 0;
  for (let i = 0; i < n; i++) { sab += (a[i] - ma) * (b[i] - mb); saa += (a[i] - ma) ** 2; sbb += (b[i] - mb) ** 2; }
  return saa && sbb ? sab / Math.sqrt(saa * sbb) : 0;
};
const typeName = name => name.replace(/^(Left|Right|Top|Bottom|Front|Back)\s+/i, '').split(' - ')[0]
  .replace(/-\d+[A-Za-z]?\s*$/, '').replace(/[\s-]*\d+\s*$/, '').replace(/\s+[A-Z]\s*$/, '').replace(/^[\s-]+|[\s-]+$/g, '');

// ------------------------------------------------------------------ power groups
function powerGroups(models) {
  const point = m => (m.nodes || 1) <= 4;
  const lit = models.filter(m => !point(m));                // floods: hits only, never washes
  const G = [];
  const add = (name, tier, members) => { if (members.length) G.push({ name, tier, members, propType: dominant(members) }); };
  add('01_BASE_All', 1, lit);
  // GEO: thirds by position
  const xs = lit.map(m => m.x).sort((a, b) => a - b), ys = lit.map(m => m.y).sort((a, b) => a - b), n = lit.length;
  const xl = n >= 3 ? xs[Math.floor(n / 3)] : -Infinity, xh = n >= 3 ? xs[Math.floor(2 * n / 3)] : Infinity;
  const yl = n >= 3 ? ys[Math.floor(n / 3)] : -Infinity, yh = n >= 3 ? ys[Math.floor(2 * n / 3)] : Infinity;
  add('02_GEO_Top', 2, lit.filter(m => m.y > yh)); add('02_GEO_Bot', 2, lit.filter(m => m.y <= yl));
  add('02_GEO_Left', 2, lit.filter(m => m.x < xl)); add('02_GEO_Right', 2, lit.filter(m => m.x >= xh));
  // BEAT: each kind of prop dealt round-robin over 4 groups (floods included: a flash is a hit)
  const buckets = new Map();
  for (const m of models) { const k = m.name.split(' - ')[0].replace(/[\s-]*\d+\s*$/, '').replace(/\s+[A-Z]\s*$/, '').trim(); if (!buckets.has(k)) buckets.set(k, []); buckets.get(k).push(m); }
  const beat = [[], [], [], []]; let off = 0;
  for (const list of [...buckets.values()].sort((a, b) => b.length - a.length)) { list.forEach((m, i) => beat[(i + off) % 4].push(m)); off += list.length; }
  beat.forEach((list, i) => add(`04_BEAT_${i + 1}`, 4, list.sort((a, b) => a.x - b.x)));
  // PROP: every kind with 2+ (by name stem, then by display type)
  const kinds = new Map();
  for (const m of lit) { const k = typeName(m.name); if (!kinds.has(k)) kinds.set(k, []); kinds.get(k).push(m); }
  const familied = new Set();
  for (const [k, list] of [...kinds.entries()].sort()) if (list.length >= 2) { add(`06_PROP_${k.replace(/\W+/g, '_')}`, 6, list); list.forEach(m => familied.add(m.name)); }
  const lines = models.filter(m => m.type === 'Single Line' && !familied.has(m.name) && !point(m));
  if (lines.length >= 2) add('06_PROP_Horizontal_Lines', 6, lines);
  // HERO: faces, mega trees, toppers, and the biggest props (cut at the biggest size gap ≥ 1.5×)
  const heroes = new Set(lit.filter(m => /face|megatree|mega tree|topper/i.test(m.name)).map(m => m.name));
  const top = lit.slice().sort((a, b) => (b.nodes || 0) - (a.nodes || 0)).slice(0, 10);
  let cut = -1, best = 1.5;
  for (let i = 0; i + 1 < top.length; i++) { const r = (top[i].nodes || 1) / Math.max(1, top[i + 1].nodes || 1); if (r >= best) { best = r; cut = i; } }
  if (cut >= 0) top.slice(0, cut + 1).forEach(m => heroes.add(m.name));
  for (const name of heroes) { const m = lit.find(x => x.name === name); add(`08_HERO_${name.replace(/\W+/g, '_')}`, 8, [m]); }
  return G;
}
function dominant(members) {
  const c = {}; for (const m of members) { const k = lib.propClass(m); c[k] = (c[k] || 0) + 1; }
  return Object.keys(c).sort((a, b) => c[b] - c[a])[0] || 'outline';
}
const recipeFor = g => { if (g.tier !== 6 && g.tier !== 8) return null; const n = g.name.replace(/^0\d_(PROP|HERO)_/, ''); const hit = RECIPE.find(([, re]) => re.test(n)); return hit ? hit[0] : null; };

// ------------------------------------------------------------------ variant scoring (variants/scorer.py)
const ENERGY_ADJ = { low: ['medium'], medium: ['low', 'high'], high: ['medium'] };
const TIER_ADJ = { background: ['mid'], mid: ['background', 'foreground'], foreground: ['mid', 'hero'], hero: ['foreground'] };
const SUIT = { ideal: 1, good: 0.75, possible: 0.25 };
const TIER_AFF = { 1: 'background', 2: 'background', 3: 'mid', 4: 'mid', 5: 'mid', 6: 'mid', 7: 'foreground', 8: 'hero' };
function score(v, ctx) {
  const suit = (EFFECTS[v.effect]?.prop_suitability || {})[ctx.propType];
  const e = v.energy === ctx.energy ? 1 : (ENERGY_ADJ[ctx.energy] || []).includes(v.energy) ? 0.5 : 0;
  const t = v.tier === ctx.tier ? 1 : (TIER_ADJ[ctx.tier] || []).includes(v.tier) ? 0.5 : 0;
  const r = !v.sections?.length ? 0.5 : v.sections.includes(ctx.role) ? 1 : 0;
  return 0.30 * (SUIT[suit] ?? 0) + 0.25 * e + 0.20 * t + 0.15 * r + 0.05 * 0.5 + 0.05 * 1;
}
const energyLevel = e => (e <= 33 ? 'low' : e <= 66 ? 'medium' : 'high');

// ------------------------------------------------------------------ the engine
function build({ a, layout, models, sections: secs, bars, beats, beatLen, seed, show, anchor, forceTheme }) {
  const out = [];
  const meta = { sections: [], groups: [] };
  const groups = powerGroups(models);
  meta.groups = groups.map(g => `${g.name} (${g.members.length})`);
  const push = (el, role, start, end, effect, settings, colors, brightness = 100, extra = {}) => {
    if (end - start < 0.025) return;
    out.push({ el, role, start, end, effect, settings: { ...(FORCE[effect] || {}), ...settings }, colors, brightness: Math.round(brightness), ...extra });
  };
  const pushG = (g, role, start, end, effect, settings, colors, brightness, extra) => g.members.forEach(m => push(m.name, role, start, end, effect, settings, colors, brightness, extra));
  const fadeFor = d => {                                   // compute_scaled_fades, in seconds
    const ms = d * 1000; if (ms < 500) return 0;
    const raw = ms <= 4000 ? Math.max(50, Math.min(500, 0.08 * ms)) : Math.max(200, Math.min(2000, 0.10 * ms));
    const snapped = FADE_STEPS.reduce((b, x) => (Math.abs(x - raw) < Math.abs(b - raw) ? x : b), FADE_STEPS[0]);
    return Math.min(snapped, 0.2 * ms) / 1000;
  };
  const withFades = (s, d) => { const f = fadeFor(d); return f >= 0.05 ? { ...s, T_TEXTCTRL_Fadein: f.toFixed(2), T_TEXTCTRL_Fadeout: f.toFixed(2) } : s; };
  const energyAt = t => { const e = a.energy || []; let best = null; for (const x of e) { if (x.time > t) break; best = x; } return best ? best.value * 100 : 50; };

  // ---- section energy (0–100 within the song) and mood
  const meanI = s => { const b = bars.filter(x => x.section === s); return b.reduce((t, x) => t + (x.intensity ?? 0.5), 0) / Math.max(1, b.length); };
  const raw = secs.map(meanI), lo = Math.min(...raw), hi = Math.max(...raw);
  const minor = /min/.test(a.key?.mode || '');
  const S = secs.map((s, i) => {
    const energy = hi - lo < 0.03 ? 50 : Math.round(100 * (raw[i] - lo) / (hi - lo));
    let mood = energy <= 33 ? 'ethereal' : energy <= 66 ? 'structural' : 'aggressive';
    if (mood === 'ethereal' && /chorus|climax/.test(s.type)) mood = 'structural';      // never a dark chorus
    return { s, i, label: s.type, energy, mood, themeMood: minor && mood === 'ethereal' ? 'dark' : mood, start: s.start, end: s.end };
  });

  // ---- themes (theme_selector.py): by mood + occasion, same label → same theme, neighbours differ
  const occasion = show === 'christmas' ? 'christmas' : show === 'halloween' ? 'halloween' : 'general';
  const byLabel = new Map(); let prev = null;
  for (const x of S) {
    let theme = forceTheme ? THEMES.find(t => t.name === forceTheme) : byLabel.get(x.label);
    if (!theme) {
      {
        // the occasion's own themes plus the general ones of the same mood (x-onset's Halloween set has one
        // loud theme, so on its own every loud Halloween section would be Jack-o-Lantern); colours come
        // from the song's look either way. Christmas keeps to Christmas themes when it has the mood.
        const own = THEMES.filter(t => t.mood === x.themeMood && t.occasion === occasion);
        const general = THEMES.filter(t => t.mood === x.themeMood && t.occasion === 'general');
        const cands = occasion === 'christmas' && own.length >= 2 ? own : own.concat(general);
        if (!cands.length) break;
        const rot = cands.slice(seed % cands.length).concat(cands.slice(0, seed % cands.length));
        theme = rot.find(t => t.name !== prev) || rot[0];
      }
      theme = theme || THEMES[seed % THEMES.length];
      byLabel.set(x.label, theme);
    }
    x.theme = theme; x.vseed = seed + x.i; prev = theme.name;
    const alts = theme.alternates || [];
    if (x.vseed > 0 && alts.length) {
      const L = alts[(x.vseed - 1) % alts.length].layers.slice();
      x.layers = L.length < theme.layers.length ? L.concat(theme.layers.slice(L.length)) : L;
    } else x.layers = theme.layers;
    x.layers = x.layers.filter(l => usable(byVariant.get(l.variant)));
  }

  // ---- per-section decisions (_populate_assignment_decisions)
  for (const x of S) {
    const sb = bars.filter(b => b.section === x.s);
    if (x.mood === 'ethereal') x.tiers = new Set([1, 8]);
    else if (x.mood === 'structural') {
      const be = sb.map(b => energyAt(b.start));
      const strong = be.length >= 8 && pearson(be.slice(0, -4), be.slice(4)) >= 0.7;
      x.tiers = new Set(strong ? [1, 2, 8] : [1, 6, 8]);
    } else x.tiers = new Set([1, 4, 6, 8]);
    x.density = x.energy <= 35 ? 0.4 : x.energy <= 70 ? 0.7 : 1;
    const bpm = a.bpm || 120;
    const base = bpm <= 80 ? 3000 : bpm >= 140 ? 500 : 3000 + (bpm - 80) * (500 - 3000) / 60;
    const target = Math.max(250, Math.min(8000, base * (1.3 - 0.6 * x.energy / 100)));
    x.dur = { target: target / 1000, min: Math.max(0.25, target / 2000), max: Math.min(8, target * 2 / 1000) };
    x.bars = sb;
    // colours: the song's look is the anchor; BASE/GEO a dim (lightness 0.40) wash of its saturated colours,
    // accents the theme's accent palette turned halfway toward the anchor
    const accent0 = x.theme.accent_palette?.length ? x.theme.accent_palette : lighten(x.theme.palette, 0.5);
    x.bg = darken(saturated(anchor).length ? saturated(anchor) : anchor, 0.40);
    x.accent = blendHue(accent0.map(c => c.toUpperCase()), anchor, 0.5);
    meta.sections.push({ label: x.label, start: +x.start.toFixed(2), energy: x.energy, mood: x.mood, theme: x.theme.name,
      tiers: [...x.tiers].sort(), layers: x.layers.map(l => l.variant) });
  }

  // ---- rotation plan for PROP and HERO groups (rotation.py)
  const rotGroups = groups.filter(g => g.tier >= 5);
  const plan = new Map();                                  // `${i}|${group}` → variant
  const lastByLabel = new Map(); const counts = {}; let total = 0;
  for (const x of S) {
    if (!x.layers.length) continue;
    const prevMap = lastByLabel.get(x.label) || {}, now = {};
    const usedTier = { 5: new Set(), 6: new Set(), 7: new Set(), 8: new Set() };
    for (const g of rotGroups) {
      const layer = g.tier >= 7 && x.layers.length > 1 ? x.layers[x.layers.length - 1] : x.layers[0];
      const ctx = { propType: g.propType, energy: energyLevel(x.energy), tier: TIER_AFF[g.tier], role: x.label };
      let results = null;
      if (layer.effect_pool?.length) {
        const pool = layer.effect_pool.map(n => byVariant.get(n)).filter(usable).map(v => [v, score(v, ctx)]).sort((p, q) => q[1] - p[1]);
        if (pool.length && pool[0][1] >= 0.3) results = pool;
      }
      if (!results) results = variants.filter(usable).filter(v => v.scope !== 'group' && (v.effect !== 'Snowflakes' || show === 'christmas')).map(v => [v, score(v, ctx)]).sort((p, q) => q[1] - p[1]);
      if (!results.length) continue;
      if (prevMap[g.name]) results = results.map(([v, s]) => [v, v.name === prevMap[g.name] ? s * 0.85 : s]).sort((p, q) => q[1] - p[1]);
      // near-ties broken by a hash of song, section and group, so each song gets its own picks
      const tie = list => { const top = list[0][1]; const t = list.filter(r => top - r[1] < 0.06); return t[crc(`${seed}:${x.i}:${g.name}`) % t.length]; };
      let pick = tie(results);
      if (usedTier[g.tier]?.has(pick[0].effect)) {
        const unclaimed = results.filter(([v, s]) => !usedTier[g.tier].has(v.effect) && s >= 0.3);
        if (unclaimed.length) pick = tie(unclaimed);
        else { const dense = results.filter(([v]) => DENSE.has(v.effect)); if (dense.length) pick = tie(dense); }
      }
      if (total && (counts[pick[0].effect] || 0) / total >= 0.25) {
        const alt = results.filter(([v, s]) => v.effect !== pick[0].effect && !usedTier[g.tier]?.has(v.effect) && (counts[v.effect] || 0) / total < 0.25 && s >= 0.3);
        if (alt.length) pick = tie(alt);
      }
      usedTier[g.tier]?.add(pick[0].effect);
      counts[pick[0].effect] = (counts[pick[0].effect] || 0) + 1; total++;
      plan.set(`${x.i}|${g.name}`, pick[0]); now[g.name] = pick[0].name;
    }
    lastByLabel.set(x.label, now);
  }

  // ---- placement helpers
  const instParams = (effect, params, k, cycle) => {
    const p = { ...params };
    if (cycle?.param && cycle.values?.length) p[cycle.param] = cycle.values[k % cycle.values.length];
    else {
      for (const [key, dirs] of Object.entries(ALT_DIR)) if (key in p) p[key] = dirs[k % dirs.length];
      if (effect === 'Single Strand') p.E_CHOICE_Chase_Type1 = ['Left-Right', 'Right-Left'][k % 2];
      if (effect === 'Pinwheel') p.E_CHECKBOX_Pinwheel_Rotation = k % 2 === 0 ? '1' : '0';
    }
    return p;
  };
  const behavior = effect => (EFFECTS[effect]?.duration_behavior) || 'standard';
  // _place_effect_on_group with duration scaling on
  function placeOnGroup(g, role, x, v, palette, { sustained = false, settingsExtra = {} } = {}) {
    const params = { ...v.settings, ...settingsExtra };
    const beh = sustained ? 'sustained' : behavior(v.effect);
    if (beh === 'sustained') return pushG(g, role, x.start, x.end, v.effect, withFades(params, x.end - x.start), palette, 100);
    if (beh === 'accent') {                                // per beat
      const bts = beats.filter(t => t >= x.start - 0.02 && t < x.end);
      return bts.forEach((t, k) => { const e = Math.min(bts[k + 1] ?? t + beatLen, x.end); if (e - t >= 0.25) pushG(g, role, t, e, v.effect, instParams(v.effect, params, k, v.cycle), palette, 100); });
    }
    // standard: split/merge bars to the section's target length
    const edges = [x.start, ...x.bars.map(b => b.start).filter(t => t > x.start + 0.05 && t < x.end - 0.05), x.end];
    let k = 0;
    for (let i = 0; i + 1 < edges.length; i++) {
      const s0 = edges[i], s1 = edges[i + 1], d = s1 - s0;
      const parts = d > x.dur.max ? Math.max(2, Math.round(d / x.dur.target)) : 1;
      for (let j = 0; j < parts; j++) {
        const a0 = s0 + j * d / parts, a1 = j === parts - 1 ? s1 : s0 + (j + 1) * d / parts;
        if (a1 - a0 < Math.min(x.dur.min, 0.25) && parts > 1) continue;
        const min = EFFECTS[v.effect]?.min_duration_ms ? EFFECTS[v.effect].min_duration_ms / 1000 : 0;
        if (a1 - a0 < min) continue;
        pushG(g, role, a0, a1, v.effect, withFades(instParams(v.effect, params, k++, v.cycle), a1 - a0), palette, 100);
      }
    }
  }
  const vivid = pal => {                                    // _vivid_mask_color candidates
    const out2 = [];
    for (const c of pal) { const [h, s] = toHsl(c); if (s < 0.25) continue; if (out2.some(o => Math.min(Math.abs(o - h), 360 - Math.abs(o - h)) < 25)) continue; out2.push(h); }
    if (!out2.length) return ['#FF0000', '#00FF00', '#0000FF'];
    while (out2.length < 3) out2.push((out2[0] + (out2.length === 1 ? 30 : -30) + 360) % 360);
    return out2.map(h => fromHsl(h, 1, 0.5));
  };
  const recipeOcc = {};
  function placeRecipe(g, fam, x) {                        // corpus recipe: motion per beat, vivid colour every 4 beats
    const occ = recipeOcc[fam] = (recipeOcc[fam] ?? -1) + 1;
    const alt = (occ + seed) % 2 === 1;
    const cols = vivid(x.accent.concat(anchor));
    const offC = crc(g.name) % cols.length;
    const bts = beats.filter(t => t >= x.start - 0.02 && t < x.end);
    const every = alt && (fam === 'cane' || fam === 'line') ? 4 : 1;     // the alternate style places once a bar
    bts.forEach((t, k) => {
      if (k % every) return;
      const e = Math.min(bts[k + every] ?? t + beatLen * every, x.end);
      const flip = Math.floor(k / 4) % 2 === 1;
      const mv = recipeMove(fam, alt, k, flip);
      pushG(g, 'x-prop', t, e, mv.effect, mv.settings, [cols[(offC + Math.floor(k / (every === 4 ? 4 : 4))) % cols.length]], 100);
    });
  }
  const qualifies = (fam, x) => /chorus|drop|hook|climax/.test(x.label) || (fam === 'arch' && /bridge/.test(x.label)) || x.energy >= 65;

  // ---- place every section
  for (const x of S) {
    if (!x.layers.length) continue;
    const n = x.layers.length;
    const tierMap = n === 1 ? [[1, 2, 4, 6, 8]] : n === 2 ? [[1, 2, 4, 6], [7, 8, 1]] : x.layers.map((_, i) => (i === 0 ? [1, 2, 4, 6] : i === n - 1 ? [7, 8] : [3, 4, 5, 6, 1]));
    const tierGroups = {};
    for (const g of groups) if (x.tiers.has(g.tier)) (tierGroups[g.tier] = tierGroups[g.tier] || []).push(g);
    if (tierGroups[6]) {                                  // quieter sections light fewer prop kinds
      const ordered = tierGroups[6].slice().sort((p, q) => crc(`${seed}:${x.i}:${p.name}`) - crc(`${seed}:${x.i}:${q.name}`));
      tierGroups[6] = ordered.slice(0, Math.max(1, Math.round(ordered.length * x.density)));
    }
    const recipeDone = new Set();
    const plays = x.plays = {};
    x.layers.forEach((layer, li) => {
      const v = byVariant.get(layer.variant);
      for (const tier of tierMap[li] || []) {
        const avail = tierGroups[tier] || [];
        if (!avail.length) continue;
        const palette = restrain(tier <= 2 ? x.bg : x.accent, x.energy, tier);
        if (tier === 1) {                                  // BASE: one sustained wash (ethereal: 4/8-bar segments)
          const g = avail[0];
          plays[g.name] = (plays[g.name] ? plays[g.name] + ' + ' : '') + v.name;
          const role = li === 0 ? 'x-base-0' : 'x-base-1';
          const spark = { sparkles: Math.min(20, 15 + Math.round(x.energy * 0.5)) };
          if (x.tiers.size === 2 && x.tiers.has(8) && li === 0) {
            const seg = [4, 8][(seed + x.i) % 2];
            for (let b = 0; b < x.bars.length; b += seg) {
              const s0 = x.bars[b].start, s1 = (x.bars[b + seg] || {}).start ?? x.end;
              if (s1 - s0 < 2) continue;
              const rot = palette.map((_, k) => palette[(k + b / seg) % palette.length]);
              pushG(g, role, s0, s1, v.effect, withFades(instParams(v.effect, v.settings, b / seg, v.cycle), s1 - s0), rot, 100, spark);
            }
          } else pushG(g, role, x.start, x.end, v.effect, withFades(v.settings, x.end - x.start), palette, 100, v.effect === 'Color Wash' || li === 0 ? spark : {});
        } else if (tier === 2) {                           // GEO: call (left/top) and answer (right/bottom) every 4 bars
          const eff = BLOCKY_BOX.has(v.effect) ? BOX_SAFE[x.vseed % BOX_SAFE.length] : v.effect;
          const params = eff === v.effect ? v.settings : {};
          const call = avail.filter(g => /Left|Top/.test(g.name)), answer = avail.filter(g => /Right|Bot/.test(g.name));
          plays['02_GEO'] = `${eff}: left/top answered by right/bottom every 4 bars`;
          for (let p = 0; p * 4 < x.bars.length; p++) {
            const s0 = x.bars[p * 4].start, s1 = (x.bars[p * 4 + 4] || {}).start ?? x.end;
            for (const g of (p % 2 ? answer : call)) pushG(g, 'x-geo', s0, s1, eff, withFades(instParams(eff, params, p), s1 - s0), palette, 100);
          }
        } else if (tier === 4) {                           // BEAT: chase over the 4 groups, direction follows the energy
          const eff = BLOCKY_BOX.has(v.effect) ? 'Color Wash' : v.effect;
          const params = eff === v.effect ? v.settings : {};
          let marks = beats.filter(t => t >= x.start - 0.02 && t < x.end);
          const dens = Math.max(0.5, Math.min(0.95, 0.5 + x.energy / 100 * 0.4));
          if (dens < 0.95) { const keep = Math.max(1, Math.floor(marks.length * dens)), step = marks.length / keep; marks = Array.from({ length: keep }, (_, i) => marks[Math.floor(i * step)]); }
          let pos = -1, dir = 1;
          plays['04_BEAT'] = `${eff}: chase over 4 groups, one beat each`;
          marks.forEach((t, i) => {
            if (i >= 4) {
              const cur = (energyAt(marks[i - 1]) + energyAt(marks[i - 2])) / 2, prv = (energyAt(marks[i - 3]) + energyAt(marks[i - 4])) / 2;
              if (cur > prv + 2) dir = 1; else if (cur < prv - 2) dir = -1;
            }
            pos = (pos + dir + avail.length) % avail.length;
            const e = Math.min(marks[i + 1] ?? t + 0.5, x.end);
            if (e > t) pushG(avail[pos], 'x-beat', t, e, eff, instParams(eff, params, i), palette, 100);
          });
        } else if (tier === 6 || tier === 8) {
          const list = tier === 8 ? [avail[li % avail.length], ...avail.filter((g, k) => k !== li % avail.length && recipeFor(g))] : avail;
          for (const g of list) {
            const fam = recipeFor(g);
            if (fam && !recipeDone.has(g.name) && qualifies(fam, x)) { placeRecipe(g, fam, x); recipeDone.add(g.name); plays[g.name] = `${fam} recipe: motion on every beat, colour every 4`; continue; }
            if (recipeDone.has(g.name)) continue;
            let rv = plan.get(`${x.i}|${g.name}`);
            if (!rv) continue;
            if (tier === 8 && g.propType === 'matrix' && MATRIX_LOW.has(rv.effect)) {
              const sub = MATRIX_OK[(x.vseed + li) % MATRIX_OK.length];
              rv = { name: sub, effect: sub, settings: {} };
            }
            placeOnGroup(g, tier === 8 ? 'x-hero' : 'x-prop', x, rv, palette);
            plays[g.name] = rv.name;
            recipeDone.add(g.name);
          }
        }
      }
    });

    // ---- accents for this section
    const smallRadial = models.filter(m => (m.type === 'Star' || RADIAL_WORDS.test(m.name)) && (m.nodes || 1) <= 200 && (m.nodes || 1) > 4);
    if (x.energy >= 60 && smallRadial.length) {             // drum hits on small stars/spinners
      const hits = ['kick', 'snare', 'hihat'].flatMap(k => (a.drums?.[k] || []).filter(h => h.time >= x.start && h.time < x.end && (h.velocity ?? 1) >= 0.15).map(h => ({ t: h.time, k })))
        .sort((p, q) => p.t - q.t);
      const share = hits.length ? Math.max(...['kick', 'snare', 'hihat'].map(k => hits.filter(h => h.k === k).length)) / hits.length : 0;
      const MAP = { kick: 'Shockwave Full Fast', snare: 'On Bold', hihat: 'Strobe Dual Fast' };
      let last = -1, n2 = 0;
      for (const h of hits) {
        if (h.t - last < 0.15) continue;
        last = h.t;
        const name = share > 0.8 ? ['Shockwave Full Fast', 'On Bold'][n2++ % 2] : MAP[h.k];
        const vv = byVariant.get(name);
        smallRadial.forEach(m => push(m.name, 'x-accent', h.t, h.t + 0.275, vv.effect, vv.settings, restrain(x.accent, x.energy, 4), 100));
      }
    }
    if (x.energy > 80 && /chorus|drop|climax/.test(x.label) && x.end - x.start >= 4) {      // impact ring
      const members = new Set(groups.filter(g => g.tier >= 4).flatMap(g => g.members.map(m => m.name)));
      for (const name of members) push(name, 'x-accent', x.start, x.start + 0.8, 'Shockwave', { E_SLIDER_Shockwave_Start_Radius: 1,
        E_SLIDER_Shockwave_End_Radius: 100, E_SLIDER_Shockwave_Start_Width: 5, E_SLIDER_Shockwave_End_Width: 35, E_CHECKBOX_Shockwave_Blend_Edges: 1 }, ['#FFFFFF'], 100);
    }
    const layersWanted = x.energy < 40 ? 0 : x.energy < 60 ? 1 : x.energy < 85 ? 3 : (x.vseed % 4 === 0 ? 6 : 4);
    const extra = Math.max(0, layersWanted - x.layers.length);
    const POOL = ['Shockwave', 'On', 'Pinwheel', 'Ripple'];
    const base = groups.find(g => g.tier === 1);
    let front = 0, back = 0;
    for (let i = 0; i < extra && base; i++) {               // whole-house composite layers
      const eff = POOL[(x.vseed + i) % POOL.length], ls = x.vseed + i;
      const pal = x.theme.palette.slice(0, 2);
      let params = {};
      if (eff === 'Shockwave') params = { E_CHECKBOX_Shockwave_Blend_Edges: 1, E_SLIDER_Shockwave_CenterX: 50, E_SLIDER_Shockwave_CenterY: 50,
        E_SLIDER_Shockwave_Start_Radius: [0, 5, 10][ls % 3], E_SLIDER_Shockwave_End_Radius: [100, 130, 160][Math.floor(ls / 3) % 3],
        E_SLIDER_Shockwave_Start_Width: [3, 6, 10][Math.floor(ls / 5) % 3], E_SLIDER_Shockwave_End_Width: [1, 3, 6][Math.floor(ls / 7) % 3],
        E_SLIDER_Shockwave_Cycles: [1, 2, 3][Math.floor(ls / 11) % 3], E_SLIDER_Shockwave_Accel: [-3, 0, 3][Math.floor(ls / 13) % 3] };
      if (eff === 'Pinwheel') params = { E_SLIDER_Pinwheel_Thickness: [10, 18, 25, 32][ls % 4], E_SLIDER_Pinwheel_Twist: [0, 45, 90, 135, -45, -90][Math.floor(ls / 7) % 6],
        E_SLIDER_Pinwheel_Arms: [3, 4, 5][Math.floor(ls / 11) % 3] };
      if (eff === 'Ripple') params = { E_CHOICE_Ripple_Object_To_Draw: ['Circle', 'Square', 'Triangle', 'Star', 'Polygon'][ls % 5],
        E_CHOICE_Ripple_Movement: ['Explode', 'Explode', 'Implode'][Math.floor(ls / 5) % 3], E_SLIDER_Ripple_Thickness: [8, 15, 25, 35][Math.floor(ls / 11) % 4],
        E_SLIDER_Ripple_Scale: [80, 100, 120, 150][Math.floor(ls / 13) % 4] };
      pushG(base, eff === 'Shockwave' ? `x-house-front-${front++}` : `x-house-back-${back++}`, x.start, x.end, eff, params, pal, 100);
    }
  }

  meta.sections.forEach((m, i) => { m.plays = S[i].plays || {}; });

  // ---- song-wide accents
  const words = a.words || [];
  const nearVocal = (t, pad) => words.some(w => t >= w.start - pad && t <= Math.min(w.end, w.start + 3) + pad);
  const songEnd = a.offStart || a.duration;
  // crash swells: at most 12, 3 s apart, never over singing
  const everyone = groups.find(g => g.tier === 1)?.members || [];
  let lastC = -9, nC = 0;
  for (const h of (a.drums?.crash || []).slice().sort((p, q) => (q.velocity || 0) - (p.velocity || 0))) {
    if (nC >= 12) break;
    if (Math.abs(h.time - lastC) < 3 || nearVocal(h.time, 0.5) || h.time > songEnd - 2) continue;
    if (out.some(e => e.role === 'x-crash' && Math.abs(e.start + 1 - h.time) < 3)) continue;
    nC++; lastC = h.time;
    everyone.forEach(m => push(m.name, 'x-crash', Math.max(0, h.time - 1), h.time + 0.7, 'Shockwave', { E_SLIDER_Shockwave_Start_Radius: 1,
      E_SLIDER_Shockwave_End_Radius: 120, E_SLIDER_Shockwave_Start_Width: 5, E_SLIDER_Shockwave_End_Width: 40, E_CHECKBOX_Shockwave_Blend_Edges: 1 }, ['#FFFFFF'], 100));
  }
  // star bursts on drum fills: one star at a time spins red/yellow/orange
  const stars = models.filter(m => m.type === 'Star' || /star/i.test(m.name)).filter(m => (m.nodes || 1) > 4);
  let lastFill = -9, si = 0;
  for (const h of a.drums?.toms || []) {
    if (!stars.length || h.time - lastFill < 1.05 || h.time > songEnd - 1) continue;
    lastFill = h.time;
    const m = stars[si++ % stars.length];
    push(m.name, 'x-accent', h.time, h.time + 1.05, 'Pinwheel', { E_SLIDER_Pinwheel_Arms: 3, E_SLIDER_Pinwheel_Twist: 148, E_SLIDER_Pinwheel_Thickness: 28,
      E_SLIDER_Pinwheel_Speed: 30, E_CHOICE_Pinwheel_3D: 'Sweep' }, ['#FF0000', '#FFFF00', '#FF8000'], 100);
  }
  // floods: hi-hat ticks and kick rolls, one flood at a time, white
  const floods = models.filter(m => /flood/i.test(m.name) || (m.nodes || 1) <= 4);
  if (floods.length) {
    let fi = 0;
    for (const h of a.drums?.hihat || []) {
      if (h.time > songEnd - 1 || (h.velocity ?? 1) < 0.05) continue;
      push(floods[fi++ % floods.length].name, 'x-flood', h.time, h.time + 0.12, 'On', { T_TEXTCTRL_Fadein: '0.02', T_TEXTCTRL_Fadeout: '0.04' }, ['#FFFFFF'], 100);
    }
    const kicks = (a.drums?.kick || []).map(h => h.time);
    for (let i = 0; i + 3 < kicks.length; i++) {             // a roll: 4 kicks inside one beat and a half
      if (kicks[i + 3] - kicks[i] > beatLen * 1.5 || kicks[i] > songEnd - 1) continue;
      for (let j = i; j < i + 4; j++) push(floods[fi++ % floods.length].name, 'x-flood', kicks[j], kicks[j] + 0.35, 'On', { T_TEXTCTRL_Fadein: '0.04', T_TEXTCTRL_Fadeout: '0.12' }, ['#FFFFFF'], 100);
      i += 3;
    }
  }
  return { effects: out, meta };
}

// Corpus recipe motions (corpus_recipes.py): primary / alternate per prop family
function recipeMove(fam, alt, k, flip) {
  const burst = { effect: 'Shockwave', settings: { E_SLIDER_Shockwave_CenterX: 50, E_SLIDER_Shockwave_CenterY: 50, E_SLIDER_Shockwave_Start_Radius: 1,
    E_SLIDER_Shockwave_End_Radius: 100, E_SLIDER_Shockwave_Start_Width: 5, E_SLIDER_Shockwave_End_Width: 35, E_CHECKBOX_Shockwave_Blend_Edges: 1 } };
  const chase = { effect: 'Single Strand', settings: { E_CHOICE_Chase_Type1: (k % 2) ^ flip ? 'Right-Left' : 'Left-Right', E_CHOICE_Fade_Type: 'From Head',
    E_SLIDER_Color_Mix1: 25, E_SLIDER_Number_Chases: 1, E_TEXTCTRL_Chase_Rotations: '1.0' } };
  const toMiddle = { effect: 'Single Strand', settings: { E_CHOICE_Chase_Type1: 'To Middle', E_CHOICE_Fade_Type: 'From Head', E_SLIDER_Color_Mix1: 25, E_TEXTCTRL_Chase_Rotations: '1.0' } };
  const spiral = { effect: 'Spirals', settings: { E_SLIDER_Spirals_Count: 2, E_SLIDER_Spirals_Rotation: flip ? -20 : 20, E_SLIDER_Spirals_Thickness: 60,
    E_CHECKBOX_Spirals_3D: 1, E_CHECKBOX_Spirals_Blend: 1, E_TEXTCTRL_Spirals_Movement: '1.0', B_CHOICE_BufferTransform: k % 2 ? 'Flip Horizontal' : 'None' } };
  const flatSpiral = { effect: 'Spirals', settings: { E_SLIDER_Spirals_Count: 3, E_SLIDER_Spirals_Rotation: flip ? -20 : 20, E_SLIDER_Spirals_Thickness: 50,
    E_TEXTCTRL_Spirals_Movement: '1.0', E_CHECKBOX_Spirals_Blend: 1, B_CHOICE_BufferTransform: k % 2 ? 'Flip Horizontal' : 'None' } };
  const pinwheel = { effect: 'Pinwheel', settings: { E_SLIDER_Pinwheel_Arms: 5, E_SLIDER_Pinwheel_Twist: 60, E_SLIDER_Pinwheel_Thickness: 50, E_SLIDER_Pinwheel_Speed: 22,
    E_CHOICE_Pinwheel_3D: 'Sweep', E_CHECKBOX_Pinwheel_Rotation: flip ? 0 : 1 } };
  const meteors = { effect: 'Meteors', settings: { E_SLIDER_Meteors_Count: 12, E_SLIDER_Meteors_Length: 30, E_SLIDER_Meteors_Speed: 25, E_CHOICE_Meteors_Effect: 'Down', E_CHOICE_Meteors_Type: 'Palette' } };
  const twinkle = { effect: 'Twinkle', settings: { E_SLIDER_Twinkle_Count: 50, E_SLIDER_Twinkle_Steps: 8 } };
  const wave = { effect: 'Wave', settings: { E_TEXTCTRL_Number_Waves: '2.00', E_SLIDER_Thickness_Percentage: 40, E_SLIDER_Wave_Height: 70, E_CHOICE_Wave_Direction: flip ? 'Left to Right' : 'Right to Left' } };
  switch (fam) {
    case 'snowflake': return alt ? toMiddle : burst;
    case 'arch': return alt ? burst : chase;
    case 'tree': return [burst, spiral, wave, twinkle][(alt ? 1 : 0) + 2 * (Math.floor(k / 16) % 2)] || burst;
    case 'cane': return alt ? flatSpiral : chase;
    case 'line': return alt ? burst : chase;
    case 'icicle': return alt ? meteors : spiral;
    case 'star': return alt ? pinwheel : burst;
    default: return burst;
  }
}

module.exports = { build, powerGroups };
