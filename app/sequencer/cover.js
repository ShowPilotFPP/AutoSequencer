// The song's own colour scheme, taken from its album cover.
//
// Looks the song up on the iTunes Search API (free, no key), downloads the cover
// and pulls out its strongest colours: pixels are grouped by hue, weighted by how
// vivid they are, and the top hues (at least 30° apart) become the palette —
// boosted to full brightness, because a cover's dark red is a dim red on a pixel.
const jpeg = require('jpeg-js');

async function lookupCover(title, timeoutMs = 8000) {
  const term = title.replace(/[_]+/g, ' ').replace(/\s+/g, ' ').trim();
  const ctl = AbortSignal.timeout(timeoutMs);
  const r = await fetch(`https://itunes.apple.com/search?entity=song&limit=1&term=${encodeURIComponent(term)}`, { signal: ctl });
  if (!r.ok) return null;
  const hit = (await r.json()).results?.[0];
  if (!hit?.artworkUrl100) return null;
  const url = hit.artworkUrl100.replace('100x100', '300x300');
  const img = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!img.ok) return null;
  const buf = Buffer.from(await img.arrayBuffer());
  return { url, artist: hit.artistName, track: hit.trackName, palette: paletteFromJpeg(buf) };
}

function paletteFromJpeg(buf) {
  const { width, height, data } = jpeg.decode(buf, { useTArray: true, maxMemoryUsageInMB: 64 });
  const BINS = 24, bins = Array.from({ length: BINS }, () => ({ w: 0, r: 0, g: 0, b: 0 }));
  const step = Math.max(1, Math.floor((width * height) / 20000));
  for (let i = 0; i < width * height; i += step) {
    const r = data[i * 4], g = data[i * 4 + 1], b = data[i * 4 + 2];
    const max = Math.max(r, g, b), min = Math.min(r, g, b), v = max / 255, s = max ? (max - min) / max : 0;
    if (s < 0.3 || v < 0.25) continue;                     // greys, blacks and washed-out pixels don't count
    let h;
    if (max === r) h = ((g - b) / (max - min) + 6) % 6; else if (max === g) h = (b - r) / (max - min) + 2; else h = (r - g) / (max - min) + 4;
    const bin = bins[Math.floor(h / 6 * BINS) % BINS], w = s * v;
    bin.w += w; bin.r += r * w; bin.g += g * w; bin.b += b * w;
  }
  const total = bins.reduce((t, x) => t + x.w, 0);
  if (!total) return null;
  const ranked = bins.map((x, i) => ({ ...x, i })).filter(x => x.w > total * 0.03).sort((a, b) => b.w - a.w);
  const picked = [];
  for (const x of ranked) {
    if (picked.every(p => Math.min(Math.abs(p.i - x.i), BINS - Math.abs(p.i - x.i)) >= 2)) picked.push(x);
    if (picked.length === 4) break;
  }
  if (picked.length < 2) return null;                      // a nearly one-colour cover: not enough to build a show from
  return picked.map(x => boost([x.r / x.w, x.g / x.w, x.b / x.w]));
}

function boost([r, g, b]) {
  const m = Math.max(r, g, b) || 1;
  return '#' + [r, g, b].map(c => Math.round(c * 255 / m).toString(16).padStart(2, '0')).join('').toUpperCase();
}

module.exports = { lookupCover, paletteFromJpeg };
