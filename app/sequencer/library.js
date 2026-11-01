// Effect presets and themes from derwin12/xlights-autosequencer (x-onset, MIT —
// see library/LICENSE-xonset). 204 tuned effect variants tagged by energy and
// section, 28 themes, and which effects suit which kind of prop.
const variants = require('./library/variants.json').variants;
const themes = require('./library/themes.json').themes;
const { suitability, params } = require('./library/effects.json');
const DEFAULTS = require('./library/defaults.json').defaults;

const byName = new Map(variants.map(v => [v.name, v]));
const themeByName = new Map(themes.map(t => [t.name, t]));

// What kind of surface a prop is, in the library's terms.
function propClass(model) {
  switch (model.type) {
    case 'Matrix': case 'Virtual Matrix': return 'matrix';
    case 'Arches': return 'arch';
    case 'Star': case 'Spinner': case 'Circle': return 'radial';
    case 'Tree': case 'Tree 360': case 'Tree Flat': return 'tree';
    case 'Vert Matrix': case 'Icicles': return 'vertical';
    default: return 'outline';            // Single Line, Poly Line, Window Frame, Custom...
  }
}

// Halloween default: which theme each section type wears. Override per song with one theme for everything.
const AUTO = {
  intro: 'Haunted Pulse', verse: 'Violet Night', prechorus: 'Glitch City', chorus: 'Jack-o-Lantern',
  bridge: 'Inferno', break: 'Glitch City', outro: 'Haunted Pulse', custom: 'Jack-o-Lantern',
};

// The cover look: each kind of section leads with a different pair from the cover's colours.
const COVER_ORDER = { chorus: [0, 1], verse: [1, 2], prechorus: [2, 0], bridge: [3, 1], break: [3, 2],
  intro: [1, 0], outro: [1, 0], custom: [0, 1] };

// Christmas default: which theme each section type wears
const AUTO_XMAS = {
  intro: 'Silent Night', verse: 'Warm Glow', prechorus: 'North Star', chorus: 'Festive Flash',
  bridge: 'Winter Wonderland', break: 'Candy Cane Chase', outro: 'Silent Night', custom: 'Festive Flash',
};

function themeFor(sectionType, choice, cover, look) {
  // the song's own generated look (the default): colours and signature effects picked per song
  if (look && (!choice || choice === 'auto' || choice === 'christmas')) return look.themes[sectionType] || look.themes.custom;
  if (choice === 'christmas') return themeByName.get(AUTO_XMAS[sectionType] || AUTO_XMAS.custom);
  if (choice === 'cover' && cover && cover.length >= 2) {
    const [a, b] = (COVER_ORDER[sectionType] || COVER_ORDER.custom).map(i => cover[i % cover.length]);
    const rest = cover.filter(c => c !== a && c !== b);
    // borrow presets from whichever built-in theme suits the section, keep the cover's colours
    return { name: 'Album cover', palette: [a, ...rest], accent: [b], variants: themeByName.get(AUTO[sectionType] || AUTO.custom).variants };
  }
  if (choice && !['auto', 'cover', 'christmas'].includes(choice) && themeByName.has(choice)) return themeByName.get(choice);
  return themeByName.get(AUTO[sectionType] || AUTO.custom);
}

// Lights need saturated, full-value colours: a theme's dark navy reads as "off" on a pixel.
function boost(hex) {
  const n = parseInt(hex.slice(1), 16);
  let r = n >> 16, g = (n >> 8) & 255, b = n & 255;
  const m = Math.max(r, g, b);
  if (m === 0) return '#FFFFFF';
  const k = 255 / m;
  [r, g, b] = [r, g, b].map(x => Math.round(x * k));
  return '#' + [r, g, b].map(x => x.toString(16).padStart(2, '0')).join('').toUpperCase();
}
const isWhite = h => boost(h) === '#FFFFFF';

// Two working colours for a section + the theme's full palette for effects that use several.
function colors(theme) {
  const pal = [...new Set((theme.palette || []).map(boost))];
  const acc = [...new Set((theme.accent || []).map(boost))].filter(c => !isWhite(c) && !pal.includes(c));
  const main = pal[0] || '#FF5A00';
  const second = acc[0] || pal.find(c => c !== main) || '#FFFFFF';
  return { pair: [main, second], all: [main, second, ...pal.filter(c => c !== main && c !== second)].slice(0, 4) };
}

const ENERGY = { low: 'low', calm: 'low', mid: 'medium', high: 'high' };
const SECTION = { intro: 'intro', verse: 'verse', prechorus: 'build', chorus: 'chorus', bridge: 'bridge',
  break: 'bridge', outro: 'outro', custom: 'verse' };
const ADJ = { low: ['medium'], medium: ['low', 'high'], high: ['medium'] };

// Best-matching variant for this prop / tier / section, rotating through the top few by `seed`
// so a repeated section gets a fresh look instead of the identical effect.
// Effects never auto-picked: Liquid runs a particle physics simulation that can lock
// xLights up on a big matrix; the others need a canvas, masks or files.
const NEVER = new Set(['Liquid', 'Warp', 'Kaleidoscope', 'Tendril', 'Shape', 'Fan', 'Fireworks']);

function pick({ model, tier, section, theme, role = 'background', seed = 0, exclude = [], only = null }) {
  const cls = propClass(model);
  const energy = ENERGY[tier] || 'medium';
  const sec = SECTION[section] || 'verse';
  const fromTheme = new Set(theme?.variants || []);
  const scored = [];
  for (const v of variants) {
    if (exclude.includes(v.effect) || NEVER.has(v.effect) || (only && !only.includes(v.effect))) continue;
    const fit = suitability[v.effect]?.[cls];
    if (fit !== 'ideal' && fit !== 'good' && !(only && only.includes(v.effect))) continue;
    if (v.scope === 'group') continue;
    // snow belongs to winter themes only (Winter Wonderland, Silent Night...), not Halloween
    if (v.effect === 'Snowflakes' && !theme?.winter && !/winter|snow|silent|christmas|frost|north|warm glow|festive|candy/i.test(theme?.name || '')) continue;
    let score = fit === 'ideal' ? 2 : 1;
    if (v.energy === energy) score += 3; else if ((ADJ[energy] || []).includes(v.energy)) score += 1; else continue;
    if (v.sections.includes(sec)) score += 2;
    if (fromTheme.has(v.name)) score += 3;
    if (theme?.core?.includes(v.effect)) score += 4;          // this song's signature effects
    if (role === 'background' && (v.tier === 'background' || v.tier === 'mid')) score += 1;
    if (tier === 'low' && v.speed === 'slow') score += 1;
    if (tier === 'high' && v.speed === 'fast') score += 1;
    scored.push([score, v]);
  }
  if (!scored.length) return null;
  scored.sort((x, y) => y[0] - x[0] || x[1].name.localeCompare(y[1].name));
  const top = scored.filter(([s]) => s >= scored[0][0] - 1).slice(0, 6);
  const v = top[seed % top.length][1];
  const settings = { ...v.settings };
  if (v.cycle?.param && v.cycle.values?.length) settings[v.cycle.param] = v.cycle.values[seed % v.cycle.values.length];
  return { name: v.name, effect: v.effect, settings };
}

// Make a preset move at the song's pace: speed-type settings are scaled by `factor`
// (tempo × intensity), kept inside the range xLights allows for that setting.
const SPEEDY = /(_Speed|_Cycles|_Rotations|_Rotation|Velocity\d?|_Movement)$/;
function pace(effect, settings, factor) {
  if (!factor || Math.abs(factor - 1) < 0.05) return settings;
  const out = { ...settings };
  const keys = new Set([...Object.keys(out), ...Object.keys(DEFAULTS[effect] || {})]);
  for (const k of keys) {
    if (!SPEEDY.test(k) || k.startsWith('E_CHOICE') || k.startsWith('E_CHECKBOX')) continue;
    const base = parseFloat(out[k] ?? DEFAULTS[effect]?.[k]);
    if (!Number.isFinite(base) || base === 0) continue;
    const p = params[effect]?.[k] || {};
    const lo = Number.isFinite(p.min) ? p.min : 0, hi = Number.isFinite(p.max) ? p.max : base * 4;
    let v = Math.max(lo, Math.min(hi, base * factor));
    out[k] = /SLIDER/.test(k) ? String(Math.round(v)) : v.toFixed(2);
  }
  return out;
}

const themeNames = () => themes.map(t => ({ name: t.name, mood: t.mood }));

module.exports = { pick, themeFor, colors, themeNames, propClass, pace, AUTO, themeByName };
