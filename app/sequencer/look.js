// A look for one song: its own colour scheme, its own handful of signature effects, and
// its own moves for matching props in the big parts. Every song gets a different look
// (picked from the song, so it's the same each time you open it), and "Another idea"
// steps to the next one, so the same song can be sequenced many different ways.
//
// Real sequences lean on a few core effects (x-onset's study of pro sequences: 4–9
// effects make up 90% of placements), so each look picks 6 and favours them; that's
// what makes two songs feel different rather than the same effects in new colours.

// Colour schemes per show. Each is 3–5 colours; the first two are the main pair.
const SCHEMES = {
  halloween: [
    ['Jack-o-Lantern', ['#FF5A00', '#7B00FF', '#3CFF00']],
    ['Toxic', ['#7CFF00', '#8A00FF', '#FF00B4']],
    ['Blood Moon', ['#FF0010', '#FF6A00', '#FFE2B0']],
    ['Witching Hour', ['#6A00FF', '#00E0C0', '#30FF60']],
    ['Poison Apple', ['#20FF40', '#FF0018', '#FFB000']],
    ['Ghost Light', ['#C8E4FF', '#00C8FF', '#9A40FF']],
    ['Hellfire', ['#FF1A00', '#FF7A00', '#FFD000']],
    ['Neon Graveyard', ['#FF00C8', '#00F0FF', '#8CFF00']],
    ['Cauldron', ['#00FF70', '#FFD200', '#A000FF']],
    ['Black Light', ['#7000FF', '#FF2AA0', '#00E8FF']],
    ['Pumpkin Patch', ['#FF7000', '#FFC000', '#40FF20', '#B000FF']],
    ['Vampire', ['#E00020', '#B000FF', '#FFFFFF']],
  ],
  christmas: [
    ['Classic Christmas', ['#FF0000', '#00D020', '#FFD8A0']],
    ['Candy Cane', ['#FF0010', '#FFFFFF', '#30FF80']],
    ['Frozen', ['#60C8FF', '#FFFFFF', '#2050FF', '#B070FF']],
    ['Gilded', ['#FFB000', '#FFE6B0', '#FF1010']],
    ['Retro Bulbs', ['#FF0000', '#00C020', '#1040FF', '#FFB000', '#FF00A0']],
    ['Evergreen', ['#00C030', '#FFC000', '#FFFFFF']],
    ['Nordic', ['#FF0010', '#FFFFFF', '#70D0FF']],
    ['Holly Jolly', ['#FF0000', '#00D020', '#FFB800']],
    ['Midnight Clear', ['#1A40FF', '#FFFFFF', '#FFC040']],
    ['Sugar Plum', ['#A000FF', '#FF40B0', '#D8E8FF']],
    ['Silver Bells', ['#D8E8FF', '#6090FF', '#FFFFFF', '#FFC040']],
    ['Gingerbread', ['#FF7A10', '#FFFFFF', '#FF0010', '#00C030']],
  ],
  other: [
    ['Sunset', ['#FF3000', '#FF00A0', '#FFB000']],
    ['Ocean', ['#0060FF', '#00F0D0', '#FFFFFF']],
    ['Electric', ['#00F0FF', '#FF00E0', '#FFF000']],
    ['Forest', ['#00D040', '#B0FF00', '#FFB000']],
    ['Royal', ['#7000FF', '#FFC000', '#FFFFFF']],
    ['Rainbow', ['#FF0000', '#FF9000', '#00E020', '#0050FF', '#B000FF']],
  ],
};

// Effects a look can make its signature (all have verified xLights defaults and preview support)
const CORE_POOL = ['Bars', 'Butterfly', 'Circles', 'Color Wash', 'Curtain', 'Fire', 'Galaxy', 'Garlands', 'Meteors',
  'Morph', 'Pinwheel', 'Plasma', 'Ripple', 'Shimmer', 'Shockwave', 'Single Strand', 'Spirals', 'Twinkle', 'Wave'];
const XMAS_EXTRA = ['Snowflakes'];
const NOT_FOR = { christmas: ['Fire'], halloween: [] };      // a whole song of fire doesn't say Christmas

// What a family of matching props can do on each beat of a big moment
const MOVES = {
  tree: ['burst', 'spiral', 'climb', 'rain', 'pinwheel', 'chase'],
  star: ['burst', 'pinwheel', 'ripple', 'twinkle'],
  line: ['chase', 'burst', 'bounce', 'bars', 'climb'],
  matrix: ['burst', 'pinwheel', 'spiral', 'climb', 'rain', 'ring'],
};

// Section types lean on different built-in themes for their presets (colours come from the scheme)
const MOOD_THEMES = {
  halloween: { calm: ['Haunted Pulse', 'Violet Night', 'Graveyard Fog', 'The Void', 'Stellar Wind'],
    mid: ['Glitch City', 'Cyber Grid', 'The Kraken', 'Scanning Beam'],
    big: ['Jack-o-Lantern', 'Inferno', 'Tracer Fire', 'White Heat', 'The Zipper'] },
  christmas: { calm: ['Silent Night', 'Winter Wonderland', 'Warm Glow', 'Ice Crystal'],
    mid: ['North Star', 'Candy Cane', 'Scarlet Ribbon', 'Candy Cane Chase'],
    big: ['Festive Flash', 'Solar Gold', 'Candy Cane Chase', 'North Star'] },
  other: { calm: ['Stellar Wind', 'Aurora', 'Bio-Lume'], mid: ['Cyber Grid', 'Scanning Beam', 'The Zipper'],
    big: ['Inferno', 'Molten Metal', 'Tracer Fire', 'White Heat'] },
};
const MOOD_OF = { intro: 'calm', outro: 'calm', verse: 'calm', break: 'mid', prechorus: 'mid', bridge: 'mid', chorus: 'big', custom: 'big' };
// which colours from the scheme lead in each kind of section, so a song's parts don't all match
const LEAD = { chorus: [0, 1], verse: [1, 2], prechorus: [2, 0], bridge: [2, 1], break: [1, 0], intro: [1, 2], outro: [1, 2], custom: [0, 1] };

// small, fast, repeatable random numbers from a seed
function rng(seed) {
  let s = (Math.abs(Math.floor(seed)) * 2654435761 + 1013904223) >>> 0;
  return () => { s = (s ^ (s << 13)) >>> 0; s = (s ^ (s >>> 17)) >>> 0; s = (s ^ (s << 5)) >>> 0; return s / 4294967296; };
}
const shuffle = (list, r) => { const a = list.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };

// nudge a colour's hue a few degrees, so the same scheme on two songs isn't pixel-identical
function jitter(hex, deg) {
  const n = parseInt(hex.slice(1), 16), r = (n >> 16) / 255, g = ((n >> 8) & 255) / 255, b = (n & 255) / 255;
  const mx = Math.max(r, g, b), d = mx - Math.min(r, g, b);
  if (d < 0.2) return hex;                                   // whites and near-whites stay put
  let h = d === 0 ? 0 : mx === r ? ((g - b) / d + 6) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
  h = ((h * 60 + deg) % 360 + 360) % 360;
  const S = d / mx, V = mx;
  const f = k => { const x = (k + h / 60) % 6; return V - V * S * Math.max(0, Math.min(x, 4 - x, 1)); };
  return '#' + [f(5), f(3), f(1)].map(v => Math.round(v * 255).toString(16).padStart(2, '0')).join('').toUpperCase();
}

// A stable number for a song (the same song always starts on the same look)
function songSeed(id) {
  let h = 2166136261;
  for (const ch of String(id)) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619) >>> 0; }
  return h % 100000;
}

function makeLook({ seed = 0, show = 'halloween', themeByName }) {
  const kind = SCHEMES[show] ? show : 'other';
  const r = rng(seed + 7);
  const schemes = SCHEMES[kind];
  // consecutive ideas walk through every scheme before one repeats
  const [name, base] = schemes[Math.abs(Math.floor(seed)) % schemes.length];
  const shift = Math.round((r() - 0.5) * 16);
  // rotate which colour leads, so one scheme still gives a few different looks
  const rot = Math.floor(Math.abs(Math.floor(seed)) / schemes.length) % base.length;
  const colors = base.map((_, i) => jitter(base[(i + rot) % base.length], shift));
  const pool = CORE_POOL.concat(kind === 'christmas' ? XMAS_EXTRA : []).filter(e => !(NOT_FOR[kind] || []).includes(e));
  const core = shuffle(pool, r).slice(0, 6);
  const moves = Object.fromEntries(Object.entries(MOVES).map(([k, list]) => [k, shuffle(list, r).slice(0, 2)]));
  const moodThemes = MOOD_THEMES[kind];
  const borrowed = Object.fromEntries(Object.entries(moodThemes).map(([m, list]) => [m, list[Math.floor(r() * list.length)]]));
  const themes = {};
  for (const type of Object.keys(LEAD)) {
    const [a, b] = LEAD[type].map(i => colors[i % colors.length]);
    const rest = colors.filter(c => c !== a && c !== b);
    const t = themeByName.get(borrowed[MOOD_OF[type]]) || {};
    themes[type] = { name, palette: [a, ...rest], accent: [b], variants: t.variants || [], core, generated: true, winter: kind === 'christmas' };
  }
  return { name, colors, core, moves, themes, seed, describe: `${name}: ${core.slice(0, 4).join(', ').toLowerCase()}…` };
}

module.exports = { makeLook, songSeed, SCHEMES };
