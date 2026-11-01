// Lyric cues: words in the song that the lights act out.
//
// Colour words paint the house that colour for a moment; words like "fire",
// "lightning", "moon", "scream" or "dark" trigger a matching effect. Matching is
// on whole words (with simple plural/-ing endings), and cues are spaced out so a
// chorus that says "red" eight times doesn't turn into a strobe of red.
const COLOR = {
  red: '#FF0000', crimson: '#E00020', scarlet: '#FF2010', blood: '#D00000', bloody: '#D00000',
  orange: '#FF6A00', pumpkin: '#FF6A00', amber: '#FFA000',
  yellow: '#FFD000', gold: '#FFC000', golden: '#FFC000', sun: '#FFB000', sunshine: '#FFC000',
  green: '#00FF30', emerald: '#00E060',
  blue: '#0050FF', sky: '#3090FF', ocean: '#0070FF', sea: '#0070FF',
  purple: '#9000FF', violet: '#8000FF', lavender: '#B070FF',
  pink: '#FF40A0', rose: '#FF2060',
  white: '#FFFFFF', silver: '#D8E4FF', snow: '#FFFFFF', diamond: '#E0F0FF',
};
const EFFECT = {
  fire: 'fire', flame: 'fire', burn: 'fire', burning: 'fire', burned: 'fire', hell: 'fire', inferno: 'fire', blaze: 'fire',
  lightning: 'strobe', thunder: 'strobe', strike: 'strobe', electric: 'strobe', shock: 'strobe', flash: 'strobe',
  moon: 'moon', moonlight: 'moon', stars: 'moon', star: 'moon', lunar: 'moon',
  scream: 'burst', screams: 'burst', howl: 'burst', howling: 'burst', bark: 'burst', roar: 'burst', explode: 'burst', boom: 'burst',
  ghost: 'ghost', ghosts: 'ghost', spirit: 'ghost', soul: 'ghost', haunt: 'ghost', haunted: 'ghost', spooky: 'ghost',
  dark: 'dark', darkness: 'dark', shadow: 'dark', shadows: 'dark', black: 'dark', midnight: 'dark',
  light: 'bright', bright: 'bright', shine: 'bright', shining: 'bright', glow: 'bright', alive: 'bright',
};


// Christmas shows get their own words. Nothing goes dark or spooky here: words
// trade the house between Christmas colours and festive effects instead.
const XMAS_COLOR = {
  red: '#FF0000', scarlet: '#FF2010', crimson: '#E00020', cherry: '#E00020', santa: '#FF0000', claus: '#FF0000',
  rudolph: '#FF0000', nose: '#FF0000', berry: '#E00020', berries: '#E00020', poinsettia: '#FF1020',
  green: '#00D020', holly: '#00B020', ivy: '#00B020', mistletoe: '#30E040', wreath: '#00B020', grinch: '#40FF00',
  gold: '#FFB000', golden: '#FFB000', silver: '#D8E4FF', blue: '#0050FF', purple: '#9000FF', pink: '#FF40A0',
  orange: '#FF6A00', yellow: '#FFD000',
};
const XMAS_EFFECT = {
  // red and green trading places on every beat
  light: 'redgreen', lights: 'redgreen', christmas: 'redgreen', xmas: 'redgreen', merry: 'redgreen', holiday: 'redgreen',
  holidays: 'redgreen', festive: 'redgreen', decorate: 'redgreen', decorations: 'redgreen', season: 'redgreen', yuletide: 'redgreen',
  // falling snow: cool white with snow running down the props
  snow: 'snow', snowing: 'snow', snowflake: 'snow', snowflakes: 'snow', snowman: 'snow', winter: 'snow', frosty: 'snow',
  frost: 'snow', cold: 'snow', ice: 'snow', icy: 'snow', icicle: 'snow', blizzard: 'snow', white: 'snow', wonderland: 'snow',
  // stars burst gold, the rest of the house glows warm
  star: 'star', stars: 'star', starlight: 'star', shine: 'star', shining: 'star', bethlehem: 'star', heaven: 'star',
  angel: 'star', angels: 'star', 
  // trees go green with twinkling ornaments
  tree: 'tree', trees: 'tree', pine: 'tree', evergreen: 'tree', fir: 'tree', ornament: 'tree', ornaments: 'tree', tinsel: 'tree',
  // red and white stripes run up the canes and along the roof
  candy: 'cane', cane: 'cane', canes: 'cane', peppermint: 'cane', stripe: 'cane', stripes: 'cane', sweet: 'cane', cookie: 'cane',
  cookies: 'cane', gingerbread: 'cane', pudding: 'cane', figgy: 'cane',
  // sleigh bells: quick gold and white sparkle everywhere
  bell: 'jingle', bells: 'jingle', jingle: 'jingle', sleigh: 'jingle', ring: 'jingle', ringing: 'jingle', chime: 'jingle',
  reindeer: 'jingle', ho: 'jingle', dashing: 'jingle', carol: 'jingle', carols: 'jingle',
  // a warm crackling fireplace
  fire: 'hearth', fireplace: 'hearth', chestnut: 'hearth', chestnuts: 'hearth', roasting: 'hearth', warm: 'hearth', cozy: 'hearth',
  yule: 'hearth', log: 'hearth', candle: 'hearth', candles: 'hearth', cocoa: 'hearth', chimney: 'hearth',
  // presents: every prop pops a different colour
  present: 'gift', presents: 'gift', gift: 'gift', gifts: 'gift', surprise: 'gift', wrap: 'gift', wrapping: 'gift', toy: 'gift', toys: 'gift',
  stocking: 'gift', stockings: 'gift',
  // big joyful white-gold flash
  joy: 'joy', joyful: 'joy', hallelujah: 'joy', glory: 'joy', gloria: 'joy', rejoice: 'joy', noel: 'joy', celebrate: 'joy', bright: 'joy',
  // a soft, still glow (the Christmas version of "dark" never blacks the house out)
  silent: 'hush', hush: 'hush', sleep: 'hush', asleep: 'hush', calm: 'hush', peace: 'hush', quiet: 'hush', holy: 'hush',
};
// Words nearly every Christmas song repeats all the way through: they still react,
// but at most once every 30 seconds so they don't drown out the special words.
const COMMON = new Set(['christmas', 'xmas', 'merry', 'holiday', 'holidays', 'season', 'white', 'sing', 'ring', 'holy', 'night']);
const SETS = { halloween: [COLOR, EFFECT], christmas: [XMAS_COLOR, XMAS_EFFECT] };
const setFor = show => SETS[show] || SETS.halloween;

function lookup(word, show) {
  const [colors, effects] = setFor(show);
  const w = word.toLowerCase().replace(/[^a-z]/g, '');
  if (!w) return null;
  for (const cand of [w, w.replace(/s$/, ''), w.replace(/ing$/, ''), w.replace(/ed$/, ''), w.replace(/y$/, '')]) {
    if (colors[cand]) return { kind: 'color', color: colors[cand], key: cand };
    if (effects[cand]) return { kind: effects[cand], key: cand };
  }
  return null;
}

// How long each kind of reaction holds, in beats (at least; a long sung word holds longer)
const HOLD = { color: 4, moon: 4, fire: 4, ghost: 4, strobe: 2, burst: 1.5, bright: 1.5, dark: 1.5,
  redgreen: 4, snow: 4, star: 3, tree: 4, cane: 4, jingle: 3, hearth: 4, gift: 2, joy: 2, hush: 3 };

// → [{ start, end, word, kind, color? }]
// show: 'christmas' uses the Christmas words; anything else the Halloween ones.
function findCues(words, phrases, beatLen, { minGap = 0.6, sameGap = 2.0, show } = {}) {
  const out = [];
  const lastByKey = {};
  for (const w of words || []) {
    const c = lookup(w.text, show);
    if (!c) continue;
    if (out.length && w.start - out[out.length - 1].start < minGap) continue;
    if (lastByKey[c.key] !== undefined && w.start - lastByKey[c.key] < sameGap) continue;
    if (COMMON.has(c.key) && lastByKey[c.key] !== undefined && w.start - lastByKey[c.key] < 30) continue;
    const end = Math.min(w.start + Math.max(w.end - w.start + beatLen, (HOLD[c.kind] || 2) * beatLen), w.start + 6);
    out.push({ start: w.start, end, word: w.text, ...c });
    lastByKey[c.key] = w.start;
  }
  // a reaction ends where the next one starts
  for (let i = 0; i + 1 < out.length; i++) out[i].end = Math.min(out[i].end, out[i + 1].start);
  return out;
}

module.exports = { findCues, lookup, SETS };
