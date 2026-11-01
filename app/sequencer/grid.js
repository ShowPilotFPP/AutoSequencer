// Beat-grid repair, applied when a sequence is built (so already-analyzed songs get it
// without re-running the analysis).
//
// Beat trackers sometimes switch tempo for a stretch: double time through a busy
// intro, half time through a solo or breakdown. Lights then pulse twice as fast or
// half as fast as the song for that stretch, and the bar lines drift, which throws
// every bar-based effect off. Here the song's main beat length is taken from the
// whole song, stretches at half or double speed are put back on it, and bar lines
// are re-counted in fours, keeping the phase the tracker agreed on most nearby.

function median(xs) {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)] : 0;
}

function fixBeats(beats) {
  if (beats.length < 16) return { beats, changed: 0 };
  const P = median(beats.slice(1).map((t, i) => t - beats[i]));
  const out = [beats[0]];
  let changed = 0;
  for (let i = 1; i < beats.length; i++) {
    const t = beats[i], last = out[out.length - 1], gap = t - last;
    if (gap < 0.7 * P) { changed++; continue; }               // an extra beat inside a beat: double time
    const n = Math.round(gap / P);
    if (n >= 2 && Math.abs(gap / n - P) < 0.18 * P) {        // a missing beat (or two): half time
      for (let k = 1; k < n; k++) out.push(last + (gap * k) / n);
      changed += n - 1;
    }
    out.push(t);
  }
  return { beats: out, changed, period: P };
}

function fixDownbeats(beats, downbeats, perBar = 4) {
  if (beats.length < 16) return downbeats;
  // each tracker downbeat votes for a phase (beat index mod 4) at its position
  const votes = downbeats.map(d => {
    let best = 0;
    for (let i = 1; i < beats.length; i++) if (Math.abs(beats[i] - d) < Math.abs(beats[best] - d)) best = i;
    return { i: best, phase: best % perBar };
  });
  const out = [];
  let lastBar = -perBar;
  for (let i = 0; i < beats.length; i++) {
    const near = votes.filter(v => Math.abs(v.i - i) <= 16);
    const count = Array(perBar).fill(0);
    near.forEach(v => count[v.phase]++);
    const phase = count.indexOf(Math.max(...count));
    // a bar line where the local phase says so, but never a bar shorter than 2 beats
    if (i % perBar === phase && i - lastBar >= 2) { out.push(beats[i]); lastBar = i; }
  }
  return out;
}

function repair(analysis) {
  const a = analysis;
  const { beats, changed, period } = fixBeats(a.beats || []);
  if (!changed) return { analysis: a, changed: 0 };
  const downbeats = fixDownbeats(beats, a.downbeats || []);
  return { analysis: { ...a, beats, downbeats, gridRepaired: changed, beatPeriod: period }, changed };
}

// Move everything in the analysis by dt seconds (positive = later): a manual fix for
// when the song file xLights plays starts at a slightly different point.
function shift(analysis, dt) {
  if (!dt) return analysis;
  const a = analysis, t = x => Math.max(0, x + dt);
  const spans = list => (list || []).map(x => ({ ...x, start: t(x.start), end: t(x.end) }));
  const hits = list => (list || []).map(h => ({ ...h, time: t(h.time) }));
  return {
    ...a,
    beats: (a.beats || []).map(t), downbeats: (a.downbeats || []).map(t),
    sections: spans(a.sections), chords: spans(a.chords), words: spans(a.words), phrases: spans(a.phrases),
    phonemes: spans(a.phonemes), energy: (a.energy || []).map(e => ({ ...e, time: t(e.time) })),
    drums: Object.fromEntries(Object.entries(a.drums || {}).map(([k, v]) => [k, hits(v)])),
    offStart: a.offStart ? t(a.offStart) : a.offStart,
  };
}

module.exports = { repair, shift, fixBeats, fixDownbeats };
