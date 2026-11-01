// Write an xLights sequence (.xsq) from placed effects + the analysis timing tracks.
const { build } = require('./recipes');
// Full per-effect default settings verified against real xLights (from x-onset, MIT).
// Every effect is written as defaults + our values, so xLights never has to guess
// a missing parameter.
const DEFAULTS = require('./library/defaults.json').defaults;

// Top layer first. A prop that plays several roles gets one layer per role in this order.
const PRIORITY = ['lyric-top', 'lyric', 'canvas', 'land', 'build', 'crash', 'vocals', 'matrix-lyric', 'toms', 'snare', 'kick', 'family', 'bars', 'matrix', 'background', 'gapfill', 'snare-ambient', 'kick-ambient'];

const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function paletteString(colors, brightness) {
  const parts = [];
  for (let i = 1; i <= 8; i++) {
    const c = colors[i - 1];
    parts.push(`C_BUTTON_Palette${i}=${c || '#FFFFFF'}`);
    if (c) parts.push(`C_CHECKBOX_Palette${i}=1`);
  }
  if (brightness !== 100) parts.push(`C_SLIDER_Brightness=${brightness}`);
  return parts.join(',');
}

function settingsString(effect, settings) {
  const all = { ...(DEFAULTS[effect] || {}), ...settings };
  return Object.keys(all).sort().map(k => {
    const v = all[k];
    return `${k}=${v === true ? 1 : v === false ? 0 : v}`;
  }).join(',');
}

function timingTracks(a) {
  const pts = (times, dur, hold, labels) => times.map((t, i) => {
    const next = i + 1 < times.length ? times[i + 1] : dur;
    return [t, hold ? Math.min(next, t + hold) : next, labels ? labels[i] : ''];
  });
  const beatLabels = [];
  {
    const db = a.downbeats || [];
    let j = -1, n = 0;
    for (const b of a.beats || []) {
      while (j + 1 < db.length && db[j + 1] <= b + 0.03) { j++; n = 0; }
      beatLabels.push(String(++n));
    }
  }
  const T = [];
  T.push(['AutoSeq Beats', [pts(a.beats || [], a.duration, 0, beatLabels)]]);
  T.push(['AutoSeq Downbeats', [pts(a.downbeats || [], a.duration)]]);
  T.push(['AutoSeq Sections', [(a.sections || []).map(s => [s.start, s.end, s.type.toUpperCase()])]]);
  if (a.chords?.length) T.push(['AutoSeq Chords', [a.chords.map(c => [c.start, c.end, c.name])]]);
  for (const k of ['kick', 'snare', 'toms']) {
    const h = a.drums?.[k];
    if (h?.length) T.push([`AutoSeq ${k[0].toUpperCase() + k.slice(1)}`, [pts(h.map(x => x.time), a.duration, 0.25)]]);
  }
  if (a.words?.length) {
    T.push(['AutoSeq Lyrics', [
      (a.phrases || []).map(p => [p.start, p.end, p.text]),
      a.words.map(w => [w.start, w.end, w.text]),
      (a.phonemes || []).map(p => [p.start, p.end, p.text]),
    ]]);
  }
  return T;
}

// snap to frames, sort, and trim so nothing in one layer overlaps
function clean(items, frameMs, getStart = x => x.start, getEnd = x => x.end) {
  const out = [];
  let lastEnd = 0;
  for (const it of [...items].sort((x, y) => getStart(x) - getStart(y))) {
    let s = Math.round(getStart(it) * 1000 / frameMs) * frameMs;
    let e = Math.round(getEnd(it) * 1000 / frameMs) * frameMs;
    if (s < lastEnd) {
      // trim the previous item rather than drop this one (later hits win)
      const prev = out[out.length - 1];
      if (prev && s - prev.s >= frameMs) { prev.e = s; lastEnd = s; } else { s = lastEnd; }
    }
    if (e <= s) continue;
    out.push({ s, e, it });
    lastEnd = e;
  }
  return out;
}

function writeXsq({ analysis, layout, roles, mediaFile, title, frameMs = 25, face, theme, seed = 0, effects: given }) {
  const effects = given || build(analysis, layout, roles, { face, theme, seed });
  const timings = timingTracks(analysis);

  // effect / palette dictionaries
  const effectDB = [], effectIdx = new Map(), palettes = [], paletteIdx = new Map();
  const ref = (map, list, key) => { if (!map.has(key)) { map.set(key, list.length); list.push(key); } return map.get(key); };

  // element → role → layer
  const byElement = new Map();
  for (const e of effects) {
    if (!byElement.has(e.el)) byElement.set(e.el, new Map());
    const roleMap = byElement.get(e.el);
    if (!roleMap.has(e.role)) roleMap.set(e.role, []);
    roleMap.get(e.role).push(e);
  }

  const elementXml = [];
  for (const t of timings) {
    const [name, layers] = t;
    elementXml.push(`    <Element type="timing" name="${esc(name)}">`);
    for (const layer of layers) {
      elementXml.push('      <EffectLayer>');
      for (const { s, e, it } of clean(layer, frameMs, x => x[0], x => x[1])) {
        elementXml.push(`        <Effect label="${esc(it[2])}" startTime="${s}" endTime="${e}"/>`);
      }
      elementXml.push('      </EffectLayer>');
    }
    elementXml.push('    </Element>');
  }

  const groupNames = layout.groups.map(g => g.name);
  const modelNames = layout.models.map(m => m.name);
  let count = 0;
  for (const name of [...groupNames, ...modelNames]) {
    const roleMap = byElement.get(name);
    elementXml.push(`    <Element type="model" name="${esc(name)}">`);
    if (!roleMap) {
      elementXml.push('      <EffectLayer/>');
    } else {
      const order = [...roleMap.keys()].sort((x, y) => PRIORITY.indexOf(x) - PRIORITY.indexOf(y));
      for (const role of order) {
        elementXml.push('      <EffectLayer>');
        for (const { s, e, it } of clean(roleMap.get(role), frameMs)) {
          const r = ref(effectIdx, effectDB, settingsString(it.effect, it.settings));
          const p = ref(paletteIdx, palettes, paletteString(it.colors, it.brightness));
          elementXml.push(`        <Effect ref="${r}" name="${esc(it.effect)}" startTime="${s}" endTime="${e}" palette="${p}"/>`);
          count++;
        }
        elementXml.push('      </EffectLayer>');
      }
    }
    elementXml.push('    </Element>');
  }

  const display = [
    ...timings.map(([n]) => `    <Element collapsed="${n === 'AutoSeq Lyrics' ? 0 : 1}" type="timing" name="${esc(n)}" visible="1" active="0"/>`),
    ...[...groupNames, ...modelNames].map(n => `    <Element collapsed="0" type="model" name="${esc(n)}" visible="1"/>`),
  ];

  const xml = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<xsequence BaseChannel="0" ChanCtrlBasic="0" ChanCtrlColor="0" FixedPointTiming="1" ModelBlending="true">',
    '  <head>',
    `    <version>${esc(layout.version || '2024.01')}</version>`,
    '    <author>AutoSeq</author>',
    '    <author-email></author-email>',
    '    <author-website></author-website>',
    `    <song>${esc(title)}</song>`,
    '    <artist></artist>',
    '    <album></album>',
    '    <MusicURL></MusicURL>',
    `    <comment>Generated by AutoSeq · ${analysis.bpm} BPM · ${esc(analysis.key?.name || '')} · ${esc(analysis.tempoBand || '')}</comment>`,
    `    <sequenceTiming>${frameMs} ms</sequenceTiming>`,
    '    <sequenceType>Media</sequenceType>',
    `    <mediaFile>${esc(mediaFile)}</mediaFile>`,
    `    <sequenceDuration>${analysis.duration.toFixed(3)}</sequenceDuration>`,
    '    <imageDir></imageDir>',
    '  </head>',
    `  <nextid>${effectDB.length + 1}</nextid>`,
    '  <Jukebox/>',
    '  <ColorPalettes>',
    ...palettes.map(p => `    <ColorPalette>${esc(p)}</ColorPalette>`),
    '  </ColorPalettes>',
    '  <EffectDB>',
    ...effectDB.map(s => `    <Effect>${esc(s)}</Effect>`),
    '  </EffectDB>',
    '  <DataLayers/>',
    '  <DisplayElements>',
    ...display,
    '  </DisplayElements>',
    '  <ElementEffects>',
    ...elementXml,
    '  </ElementEffects>',
    '  <lastView>Master View</lastView>',
    '</xsequence>',
    '',
  ].join('\n');

  return { xml, stats: { effects: count, palettes: palettes.length, settings: effectDB.length, timings: timings.length } };
}

module.exports = { writeXsq, PRIORITY };
