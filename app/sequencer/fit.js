// "Fit with the music": score a planned show against the song, without rendering it.
//
// The idea and the targets come from LightsAutoSequencer (socman1984-hub), measured
// on one experienced sequencer's own finished shows:
//   brightness follows loudness   r between 0.40 and 0.60
//   drum hits that show           at least 45% of drum beats visibly brighten the house
//   dark time                     5–10% of the song with the house (nearly) off
//   big parts brighter            choruses brighter than verses
// Brightness is estimated from the effects themselves (On effects exactly, moving
// effects as partly lit), weighted by how much each prop counts in the show.
const FRAME = 0.05;

function weightOf(m) {
  if (!m) return 1;
  if (/flood/i.test(m.name)) return 6;               // a flood lights up a whole wall
  return Math.max(3, Math.min(25, Math.sqrt(m.nodes || 1)));
}

function levelAt(e, t) {
  const b = (e.brightness ?? 100) / 100;
  if (e.effect === 'On') {
    const s0 = Number(e.settings.E_TEXTCTRL_Eff_On_Start ?? 100), s1 = Number(e.settings.E_TEXTCTRL_Eff_On_End ?? 100);
    const f = (t - e.start) / Math.max(1e-6, e.end - e.start);
    return b * (s0 + (s1 - s0) * f) / 100;
  }
  if (e.effect === 'Faces') return 0.3 * b;
  return 0.5 * b;
}

function score(effects, analysis, layout, indoor = new Set()) {
  const a = analysis;
  const models = new Map(layout.models.map(m => [m.name, m]));
  const end = a.offStart || a.duration;
  const n = Math.ceil(end / FRAME);
  const props = new Map();                          // el → Float32Array of levels
  for (const e of effects) {
    if (indoor.has(e.el)) continue;               // only what people outside can see counts
    if (!props.has(e.el)) props.set(e.el, new Float32Array(n));
    const arr = props.get(e.el);
    for (let i = Math.max(0, Math.floor(e.start / FRAME)); i < Math.min(n, Math.ceil(e.end / FRAME)); i++) {
      const v = levelAt(e, i * FRAME);
      if (v > arr[i]) arr[i] = v;
    }
  }
  let wsum = 0;
  const house = new Float32Array(n);
  for (const [el, arr] of props) {
    const w = weightOf(models.get(el));
    wsum += w;
    for (let i = 0; i < n; i++) house[i] += w * arr[i];
  }
  if (wsum) for (let i = 0; i < n; i++) house[i] /= wsum;
  const at = t => house[Math.max(0, Math.min(n - 1, Math.round(t / FRAME)))];
  const mean = arr => arr.reduce((x, y) => x + y, 0) / Math.max(1, arr.length);

  // 1. brightness follows loudness, per bar
  const db = a.downbeats || [];
  const barB = [], barE = [];
  for (let i = 0; i + 1 < db.length && db[i + 1] <= end; i++) {
    const s0 = Math.floor(db[i] / FRAME), s1 = Math.floor(db[i + 1] / FRAME);
    barB.push(mean(Array.from(house.subarray(s0, s1))));
    barE.push(mean((a.energy || []).filter(x => x.time >= db[i] && x.time < db[i + 1]).map(x => x.value)));
  }
  const r = corr(barB, barE);

  // 2. beats that show: every beat in a bar where the drums are playing (our hits are
  // locked to the beat grid, so the grid is the fair yardstick, not every detected roll)
  const drumHits = [...(a.drums?.kick || []), ...(a.drums?.snare || [])].map(h => h.time);
  const hits = (a.beats || []).filter(t => t < end && drumHits.some(h => Math.abs(h - t) < 0.08));
  const shown = hits.filter(t => at(t + 0.06) - at(t - 0.05) >= 0.03).length / Math.max(1, hits.length);

  // 3. dark time
  const dark = Array.from(house).filter(v => v < 0.04).length / n;

  // 4. big parts brighter than verses
  const partMean = type => mean((a.sections || []).filter(s => s.type === type)
    .flatMap(s => Array.from(house.subarray(Math.floor(s.start / FRAME), Math.floor(Math.min(s.end, end) / FRAME)))));
  const chorus = partMean('chorus'), verse = partMean('verse');

  const sub = {
    loudness: r >= 0.4 && r <= 0.6 ? 100 : Math.max(0, 100 - 250 * (r < 0.4 ? 0.4 - r : r - 0.6)),
    hits: Math.min(100, (shown / 0.45) * 100),
    dark: dark >= 0.05 && dark <= 0.10 ? 100 : Math.max(0, 100 - 1200 * (dark < 0.05 ? 0.05 - dark : dark - 0.10)),
    contrast: !verse || !chorus ? 100 : chorus > verse ? 100 : Math.max(0, 100 - 400 * (verse - chorus)),
  };
  // dark time counts least: it's one sequencer's taste, and our props keep a glow on purpose
  const total = Math.round(0.35 * sub.loudness + 0.35 * sub.hits + 0.1 * sub.dark + 0.2 * sub.contrast);
  return {
    score: total,
    loudnessR: +r.toFixed(2), hitsShown: +shown.toFixed(2), darkTime: +dark.toFixed(3),
    chorusVsVerse: [+chorus.toFixed(2), +verse.toFixed(2)], meanBrightness: +mean(Array.from(house)).toFixed(2),
    parts: sub,
  };
}

function corr(x, y) {
  const n = Math.min(x.length, y.length);
  if (n < 3) return 0;
  const mx = x.reduce((s, v) => s + v, 0) / n, my = y.reduce((s, v) => s + v, 0) / n;
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) { sxy += (x[i] - mx) * (y[i] - my); sxx += (x[i] - mx) ** 2; syy += (y[i] - my) ** 2; }
  return sxx && syy ? sxy / Math.sqrt(sxx * syy) : 0;
}

module.exports = { score };
