// AutoSeq — Node/Express front of house.
//
// Owns the song library (SQLite), uploads and downloads. The heavy analysis
// lives in the Python worker on 127.0.0.1:5051; this app hands it a file path
// and polls the job until it finishes.
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const multer = require('multer');
const { q, db, update, shape, DATA_DIR, getSetting, setSetting, rawGet, rawSet, showCtx, currentShow } = require('./db');
const { parseLayout, suggestRoles, suggestIndoor, ROLES, PARSE_VERSION } = require('./sequencer/layout');

// Load the sequencer fresh on every build, so a new recipes.js
// takes effect on the next download — no restart, no re-analysis.
function sequencer() {
  for (const k of Object.keys(require.cache)) if (k.includes(`${path.sep}sequencer${path.sep}`)) delete require.cache[k];
  return { ...require('./sequencer/xsq'), recipes: require('./sequencer/recipes'), fit: require('./sequencer/fit') };
}

const PORT = Number(process.env.PORT || 3075);
const WORKER = (process.env.AUTOSEQ_WORKER_URL || 'http://127.0.0.1:5051').replace(/\/$/, '');
const UPLOADS = path.join(DATA_DIR, 'uploads');
const AUDIO_EXT = /\.(mp3|wav|m4a|aac|flac|ogg|opus|mp4|mov|webm)$/i;

const app = express();
app.use(express.json({ limit: '1mb' }));

// Which show a request is for: the page sends it as an X-Show header (or ?show= on links)
const showIds = () => (rawGet('shows', []) || []).map(x => x.id);
app.use((req, res, next) => {
  const want = String(req.get('x-show') || req.query.show || '');
  req.show = showIds().includes(want) ? want : 'halloween';
  showCtx.run({ show: req.show }, next);
});
// file uploads finish in a different async context, so put the show back before the handler runs
const keepShow = (req, res, next) => { showCtx.enterWith({ show: req.show || 'halloween' }); next(); };
app.use(express.static(path.join(__dirname, 'public')));
require('./updater').routes(app);   // Update button: installs new releases from GitHub

const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOADS,
    filename: (req, file, cb) => {
      req.songId = crypto.randomBytes(6).toString('hex');
      cb(null, req.songId + path.extname(file.originalname).toLowerCase());
    },
  }),
  limits: { fileSize: 300 * 1024 * 1024 },
  fileFilter: (req, file, cb) => cb(null, AUDIO_EXT.test(file.originalname)),
});

// ------------------------------------------------------------------ worker

async function worker(pathname, opts = {}) {
  const r = await fetch(WORKER + pathname, {
    ...opts,
    headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
    signal: AbortSignal.timeout(10000),
  });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) {
    const err = new Error(body.detail || `worker ${r.status}`);
    err.status = r.status;
    throw err;
  }
  return body;
}

async function submit(song, { force = false, mode = 'full' } = {}) {
  try {
    const { job_id } = await worker('/analyze', {
      method: 'POST',
      body: JSON.stringify({ path: song.path, lyrics: song.lyrics || null, separate: !!song.separate, force, mode,
        title: song.title.replace(/[_]+/g, ' ') }),
    });
    update(song.id, { worker_job: job_id, status: 'queued', stage: 'queued', pct: 0, error: null, log: '[]' });
  } catch (e) {
    update(song.id, { status: 'error', error: `Couldn't reach the analysis worker (${e.message}). Is it running?` });
  }
}

// Poll every active job. Runs in the server, so progress keeps moving with no browser open.
let polling = false;
async function pollActive() {
  if (polling) return;
  polling = true;
  try {
    for (const song of q.active.all()) {
      if (!song.worker_job) { await submit(song); continue; }
      try {
        const j = await worker(`/jobs/${song.worker_job}`);
        const fields = { status: j.status, stage: j.stage, pct: j.pct, log: JSON.stringify(j.log || []) };
        if (j.status === 'done') {
          Object.assign(fields, { song_hash: j.songHash, result_dir: j.resultDir, summary: JSON.stringify(j.summary) });
        }
        if (j.status === 'error') fields.error = (j.log || []).slice(-1)[0] || 'analysis failed';
        update(song.id, fields);
      } catch (e) {
        if (e.status === 404) {
          update(song.id, { status: 'error', error: 'The worker restarted mid-analysis. Press Re-run to start it again.' });
        } // other errors: worker briefly unreachable — try again next tick
      }
    }
  } finally {
    polling = false;
  }
}
setInterval(pollActive, 2000);

// ------------------------------------------------------------------ routes

app.get('/api/health', async (req, res) => {
  let w = null;
  try { w = await worker('/health'); } catch (e) { w = { ok: false, error: e.message }; }
  res.json({ ok: true, worker: w });
});

app.get('/api/songs', (req, res) => {
  res.json(q.list.all(currentShow()).map(r => ({ ...r, summary: r.summary ? JSON.parse(r.summary) : null })));
});

app.post('/api/songs', upload.single('audio'), keepShow, async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Choose an audio file (mp3, wav, m4a, flac, ogg or mp4).' });
  const song = {
    id: req.songId,
    title: path.parse(req.file.originalname).name,
    filename: req.file.originalname,
    path: req.file.path,
    size: req.file.size,
    separate: req.body.separate === 'false' ? 0 : 1,
    lyrics: (req.body.lyrics || '').trim() || null,
    show_id: currentShow(),
  };
  q.insert.run(song);
  await submit(song, { force: req.body.force === 'true' });
  res.json(shape(q.get.get(song.id)));
});

app.get('/api/songs/:id', (req, res) => {
  const s = shape(q.get.get(req.params.id));
  if (!s) return res.status(404).json({ error: 'No such song.' });
  delete s.path;
  res.json(s);
});

// Re-run. mode "lyrics" redoes only words + mouth shapes on the saved vocal stem
// (fast); mode "full" re-analyzes everything.
app.post('/api/songs/:id/rerun', async (req, res) => {
  const s = q.get.get(req.params.id);
  if (!s) return res.status(404).json({ error: 'No such song.' });
  if (['queued', 'running'].includes(s.status)) return res.status(409).json({ error: 'Already analyzing.' });
  if (typeof req.body.lyrics === 'string') update(s.id, { lyrics: req.body.lyrics.trim() || null });
  if (typeof req.body.separate === 'boolean') update(s.id, { separate: req.body.separate ? 1 : 0 });
  const mode = req.body.mode === 'lyrics' ? 'lyrics' : 'full';
  if (mode === 'lyrics' && !s.result_dir) return res.status(409).json({ error: 'Run a full analysis first.' });
  await submit(q.get.get(s.id), { force: true, mode });
  res.json(shape(q.get.get(s.id)));
});

function sendResult(file, ext) {
  return (req, res) => {
    const s = q.get.get(req.params.id);
    // a finished earlier run stays downloadable while a re-run is going or after one fails
    if (!s || !s.result_dir) return res.status(404).json({ error: 'Not analyzed yet.' });
    const f = path.join(s.result_dir, file);
    if (!fs.existsSync(f)) return res.status(404).json({ error: 'Result file is missing — re-run the analysis.' });
    res.download(f, s.title.replace(/[\\/:*?"<>|]+/g, '_') + ext);
  };
}
app.get('/api/songs/:id/xtiming', sendResult('autoseq.xtiming', '.xtiming'));
app.get('/api/songs/:id/analysis', sendResult('analysis.json', '.analysis.json'));

// ------------------------------------------------------------------ layout & sequencing

const layoutUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

// Re-read the layout from the mounted show folder whenever xLights has saved it since.
function refreshFromShowFolder() {
  const dir = getSetting('showDir', '');
  if (!dir) return null;
  const file = path.join(dir, 'xlights_rgbeffects.xml');
  let st;
  try { st = fs.statSync(file); } catch { return `Can't read ${file}`; }
  if (getSetting('showMtime') === st.mtimeMs && getSetting('layout')?.models?.[0]?.geo) return null;
  try {
    const xml = fs.readFileSync(file, 'utf8');
    applyLayout(parseLayout(xml), Buffer.from(xml));
    setSetting('showMtime', st.mtimeMs);
    console.log(`layout re-read from ${file}`);
  } catch (e) { return e.message; }
  return null;
}

// props inside the house: chosen on the Show layout page, or guessed from their names
function indoorList(layout) {
  const saved = getSetting('indoor', null);
  if (saved) return saved.filter(n => layout?.models.some(m => m.name === n));
  return layout ? suggestIndoor(layout) : [];
}

const showKind = () => ((rawGet('shows', []) || []).find(x => x.id === currentShow()) || {}).kind || 'other';

function layoutState() {
  const st = layoutStateInner();
  st.indoor = indoorList(st.layout);
  return st;
}

function layoutStateInner() {
  const showError = refreshFromShowFolder();
  let layout = getSetting('layout');
  // layouts saved by an older version have no pixel geometry: re-read the saved file once
  const saved = layoutFilePath();
  if (layout && layout.models.length && layout.parseVersion !== PARSE_VERSION && fs.existsSync(saved)) {
    layout = parseLayout(fs.readFileSync(saved, 'utf8'));
    setSetting('layout', layout);
  }
  return {
    layout,
    roles: getSetting('roles', {}),
    face: getSetting('face', null),
    mediaDir: getSetting('mediaDir', ''),
    theme: getSetting('theme', showKind() === 'christmas' ? 'christmas' : 'auto'),
    show: (rawGet('shows', []) || []).find(x => x.id === currentShow()) || null,
    showDir: getSetting('showDir', ''),
    indoor: null,
    shaderCount: getSetting('shaders', []).length,
    shaderUsable: getSetting('shaders', []).filter(x => x.usable).length,
    shaderAmount: getSetting('shaderAmount', 'sometimes'),
    themes: require('./sequencer/library').themeNames(),
    roleDefs: ROLES,
    showError,
  };
}

// each show keeps its own copy of its layout (Halloween keeps the original file name)
function layoutFilePath() {
  const show = currentShow();
  return path.join(DATA_DIR, show === 'halloween' ? 'xlights_rgbeffects.xml' : `xlights_rgbeffects-${show}.xml`);
}

function applyLayout(layout, raw) {
  fs.writeFileSync(layoutFilePath(), raw);
  setSetting('layout', layout);
  // keep role picks that still exist in the new layout; suggest the rest
  const names = new Set([...layout.models.map(m => m.name), ...layout.groups.map(g => g.name)]);
  const old = getSetting('roles', {});
  const suggested = suggestRoles(layout);
  const roles = {};
  for (const r of ROLES) {
    const kept = (old[r.key] || []).filter(n => names.has(n));
    roles[r.key] = kept.length ? kept : suggested[r.key];
  }
  setSetting('roles', roles);
}

app.get('/api/layout', (req, res) => res.json(layoutState()));

// ------------------------------------------------------------------ shows
app.get('/api/shows', (req, res) => {
  const shows = rawGet('shows', []);
  const counts = Object.fromEntries(db.prepare('SELECT show_id, COUNT(*) AS n FROM songs GROUP BY show_id').all().map(r => [r.show_id, r.n]));
  res.json(shows.map(x => ({ ...x, songs: counts[x.id] || 0 })));
});
app.post('/api/shows', (req, res) => {
  const name = String(req.body?.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Give the show a name.' });
  const kind = ['halloween', 'christmas'].includes(req.body?.kind) ? req.body.kind : 'other';
  const shows = rawGet('shows', []);
  let id = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'show';
  while (shows.some(x => x.id === id)) id += '-2';
  shows.push({ id, name, kind });
  rawSet('shows', shows);
  res.json({ id, name, kind });
});
app.put('/api/shows/:id', (req, res) => {
  const shows = rawGet('shows', []);
  const sh = shows.find(x => x.id === req.params.id);
  if (!sh) return res.status(404).json({ error: 'No such show.' });
  if (req.body?.name) sh.name = String(req.body.name).trim();
  if (['halloween', 'christmas', 'other'].includes(req.body?.kind)) sh.kind = req.body.kind;
  rawSet('shows', shows);
  res.json(sh);
});

// put a song in another show too: same audio and analysis, its own sequence settings there
app.post('/api/songs/:id/copy', (req, res) => {
  const s = q.get.get(req.params.id);
  const to = String(req.body?.to || '');
  if (!s) return res.status(404).json({ error: 'No such song.' });
  if (!showIds().includes(to)) return res.status(400).json({ error: 'No such show.' });
  const id = require('crypto').randomBytes(6).toString('hex');
  db.prepare(`INSERT INTO songs (id, title, filename, path, size, status, stage, pct, separate, lyrics, song_hash, result_dir, summary, log, show_id)
    SELECT ?, title, filename, path, size, status, stage, pct, separate, lyrics, song_hash, result_dir, summary, log, ? FROM songs WHERE id = ?`).run(id, to, s.id);
  res.json({ id });
});

// The shaders in the show folder, as listed by the browser (it reads the folder, not
// the server): path inside the show folder, name, and whether the sequencer can use it.
app.put('/api/shaders', (req, res) => {
  const list = Array.isArray(req.body?.shaders) ? req.body.shaders : [];
  const clean = list.slice(0, 2000).map(x => ({
    file: String(x.file || '').replace(/\\/g, '/'), name: String(x.name || ''),
    usable: !!x.usable, why: String(x.why || ''),
    light: typeof x.light === 'number' ? Math.max(0, Math.min(1, x.light)) : undefined,
  })).filter(x => /\.fs$/i.test(x.file));
  setSetting('shaders', clean);
  res.json({ count: clean.length, usable: clean.filter(x => x.usable).length });
});

app.post('/api/layout', layoutUpload.single('layout'), keepShow, (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Choose your xlights_rgbeffects.xml.' });
  let layout;
  try { layout = parseLayout(req.file.buffer.toString('utf8')); } catch (e) {
    return res.status(400).json({ error: e.message });
  }
  applyLayout(layout, req.file.buffer);
  res.json(layoutState());
});

// start the roles over from AutoSeq's suggestions for this layout
app.post('/api/layout/suggest', (req, res) => {
  const layout = getSetting('layout');
  if (!layout) return res.status(409).json({ error: 'Add your layout first.' });
  setSetting('roles', suggestRoles(layout));
  res.json(layoutState());
});

app.put('/api/layout/roles', (req, res) => {
  const { roles, face, mediaDir, theme, showDir, shaderAmount, indoor } = req.body || {};
  if (Array.isArray(indoor)) setSetting('indoor', indoor.map(String));
  if (['never', 'sometimes', 'often'].includes(shaderAmount)) setSetting('shaderAmount', shaderAmount);
  if (showDir !== undefined) {
    setSetting('showDir', String(showDir).trim()); setSetting('showMtime', 0);
    require('./sequencer/images').reset();
  }
  if (theme !== undefined) setSetting('theme', theme || 'auto');
  if (roles) setSetting('roles', roles);
  if (face !== undefined) setSetting('face', face);
  if (mediaDir !== undefined) setSetting('mediaDir', String(mediaDir).trim());
  res.json(layoutState());
});

// The song's album-cover colours, looked up once and kept (null when there's no cover
// or it's nearly one colour). Never blocks a build for more than a few seconds.
async function coverFor(s) {
  const key = `cover:${s.id}`;
  const cached = getSetting(key);
  if (cached) return cached.palette;
  let found = null;
  try { found = await require('./sequencer/cover').lookupCover(s.title); } catch (e) {
    console.log('cover lookup failed (will retry next time):', e.message);   // network trouble: don't remember "no cover"
    return null;
  }
  setSetting(key, { palette: found?.palette || null, url: found?.url || null, at: Date.now() });
  return found?.palette || null;
}

// ------------------------------------------------------------------ imported lyric timing
// A lyric timing track made elsewhere (Autolyrics, or one fixed by hand in xLights) can
// replace AutoSeq's own word timing for a song: phrases, words and mouth shapes.
const lyricFile = s => s.result_dir && path.join(s.result_dir, 'lyrics_override.json');
function lyricOverride(s) {
  const f = lyricFile(s);
  try { return f && fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : null; } catch { return null; }
}

function parseLyricTrack(xml) {
  const { XMLParser } = require('fast-xml-parser');
  const doc = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '', isArray: n => ['timing', 'EffectLayer', 'Effect'].includes(n) }).parse(xml);
  const timings = doc.timings?.timing || doc.timing || [];
  // the lyric track is the one with three layers (phrases, words, mouth shapes)
  const t = timings.find(x => (x.EffectLayer || []).length >= 2) || timings[0];
  if (!t) throw new Error('No timing track found in that file.');
  const layer = k => (t.EffectLayer?.[k]?.Effect || []).map(e => ({ start: +e.starttime / 1000, end: +e.endtime / 1000, text: String(e.label ?? '').trim() }))
    .filter(x => x.end > x.start);
  let phrases = layer(0), words = layer(1), phonemes = layer(2);
  if (!words.length) throw new Error('That timing track has no word layer. Export the lyric track with phrases, words and phonemes.');
  // one giant "phrase" (Autolyrics does this): lines are rebuilt from the song's own
  // lyric lines when the plan is built (linesFrom); split at rests as a fallback
  const split = phrases.length <= 1 && words.length > 8;
  if (split) {
    phrases = [];
    let cur = null;
    for (const w of words) {
      if (!cur || w.start - cur.end > 0.9 || cur.n >= 14) { cur = { start: w.start, end: w.end, words: [w.text], n: 1 }; phrases.push(cur); }
      else { cur.end = w.end; cur.words.push(w.text); cur.n++; }
    }
    phrases = phrases.map(p => ({ start: p.start, end: p.end, text: p.words.join(' ') }));
  }
  const clean = w => w.toLowerCase().replace(/[^a-z' ]/g, ' ').replace(/\s+/g, ' ').trim();
  words = words.map(w => ({ ...w, text: clean(w.text) })).filter(w => w.text);
  phrases = phrases.map(p => ({ ...p, text: clean(p.text) }));
  return { name: t.name || '', words, phrases, phonemes, split };
}

// Give imported words the song's real line breaks: pair the imported words with the
// words of AutoSeq's own lyric lines (in order, by spelling) and let each line take the
// imported timing of its words. Extra imported words join the line before them.
function linesFrom(words, ownPhrases) {
  if (!ownPhrases?.length) return null;
  const own = [];
  ownPhrases.forEach((p, li) => p.text.split(/\s+/).filter(Boolean).forEach(w => own.push({ w, li })));
  const a = words.map(w => w.text), b = own.map(o => o.w);
  // longest-common-subsequence pairing
  const n = a.length, m = b.length, L = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i][j] = a[i] === b[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  const lineOf = new Array(n).fill(-1);
  for (let i = 0, j = 0; i < n && j < m;) {
    if (a[i] === b[j]) { lineOf[i++] = own[j++].li; } else if (L[i + 1][j] >= L[i][j + 1]) i++; else j++;
  }
  if (lineOf.filter(x => x >= 0).length < n * 0.6) return null;
  for (let i = 0; i < n; i++) if (lineOf[i] < 0) lineOf[i] = i ? lineOf[i - 1] : 0;
  for (let i = 1; i < n; i++) if (lineOf[i] < lineOf[i - 1]) lineOf[i] = lineOf[i - 1];   // keep order
  const out = [];
  words.forEach((w, i) => {
    const last = out[out.length - 1];
    if (last && last.li === lineOf[i]) { last.end = w.end; last.words.push(w.text); }
    else out.push({ li: lineOf[i], start: w.start, end: w.end, words: [w.text] });
  });
  return out.map(p => ({ start: p.start, end: p.end, text: p.words.join(' ') }));
}

const lyricUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });
app.post('/api/songs/:id/lyrics-track', lyricUpload.single('track'), keepShow, (req, res) => {
  const s = q.get.get(req.params.id);
  if (!s || !s.result_dir) return res.status(404).json({ error: 'Analyze the song first.' });
  if (!req.file) return res.status(400).json({ error: 'Choose an .xtiming file.' });
  let track;
  try { track = parseLyricTrack(req.file.buffer.toString('utf8')); } catch (e) { return res.status(400).json({ error: e.message }); }
  fs.writeFileSync(lyricFile(s), JSON.stringify({ file: req.file.originalname, ...track }));
  res.json(lyricInfo(s));
});
app.delete('/api/songs/:id/lyrics-track', (req, res) => {
  const s = q.get.get(req.params.id);
  if (s?.result_dir && fs.existsSync(lyricFile(s))) fs.unlinkSync(lyricFile(s));
  res.json(lyricInfo(s));
});
function lyricInfo(s) {
  const ov = s && lyricOverride(s);
  return ov ? { imported: true, file: ov.file, words: ov.words.length, phonemes: ov.phonemes.length } : { imported: false };
}

// Build the plan for a song. With no seed: make four ideas and keep the one that fits
// the music best (seeds change preset picks, colour order and glow levels).
function planFor(s, query, cover, { useOffset = true } = {}) {
  const { layout, roles, face, theme } = layoutState();
  const grid = require('./sequencer/grid');
  // repair half/double-time stretches in the beat grid, then apply this song's timing nudge
  let analysis = grid.repair(JSON.parse(fs.readFileSync(path.join(s.result_dir, 'analysis.json'), 'utf8'))).analysis;
  const ov = lyricOverride(s);
  if (ov) analysis = { ...analysis, words: ov.words, phrases: ov.split ? linesFrom(ov.words, analysis.phrases) || ov.phrases : ov.phrases, phonemes: ov.phonemes };
  const offsetMs = query.offset !== undefined && query.offset !== '' ? Number(query.offset) || 0 : getSetting(`offset:${s.id}`, 0);
  if (useOffset && offsetMs) analysis = grid.shift(analysis, offsetMs / 1000);
  const { build } = sequencer().recipes;
  const { score } = sequencer().fit;
  const opts = { face: query.face || face, theme: query.theme || theme, cover, lyricCues: query.cues !== '0', showKind: showKind(),
    shaders: getSetting('shaders', []), shaderAmount: getSetting('shaderAmount', 'sometimes'),
    indoor: indoorList(layout) };
  // idea 1 unless another one is asked for ("Another idea" steps through them)
  // each song starts on its own look (or the one last saved for it); "Another idea" asks for the next
  const { songSeed } = require('./sequencer/look');
  const seeds = [query.seed !== undefined && query.seed !== '' ? Number(query.seed) || 0 : getSetting(`look:${s.id}`, songSeed(s.id))];
  let best = null;
  for (const seed of seeds) {
    const effects = build(analysis, layout, roles, { ...opts, seed });
    const fit = score(effects, analysis, layout, new Set(opts.indoor));
    if (!best || fit.score > best.fit.score) best = { seed, effects, fit };
  }
  return { analysis, layout, roles, opts, offsetMs, ...best };
}

function songReady(req, res) {
  const s = q.get.get(req.params.id);
  if (!s || !s.result_dir) { res.status(404).json({ error: 'Analyze the song first.' }); return null; }
  if (!getSetting('layout')) { res.status(409).json({ error: 'Upload your xlights_rgbeffects.xml on the Layout page first.' }); return null; }
  return s;
}

app.get('/api/songs/:id/fit', async (req, res) => {
  const s = songReady(req, res);
  if (!s) return;
  const cover = await coverFor(s);
  const { seed, fit, effects } = planFor(s, req.query, cover);
  const a = JSON.parse(fs.readFileSync(path.join(s.result_dir, 'analysis.json'), 'utf8'));
  const repaired = require('./sequencer/grid').repair(a).changed;
  res.json({ seed, look: effects.look, savedSeed: getSetting(`look:${s.id}`, null), ...fit, lifts: effects.lifts, accents: effects.accents, cover,
    cues: effects.cues || [], handPatterns: effects.handPatterns || [], tiers: effects.tiers, lyricTrack: lyricInfo(s),
    shadersUsed: effects.shadersUsed || [],
    offsetMs: getSetting(`offset:${s.id}`, 0), gridRepaired: repaired });
});

// Everything the in-browser preview needs: pixel geometry, the planned effects with
// their layer order, and the mouth shapes for singing faces.
app.get('/api/songs/:id/plan', async (req, res) => {
  const s = songReady(req, res);
  if (!s) return;
  // the preview plays the uploaded song itself, so no nudge here
  const plan = planFor(s, req.query, await coverFor(s), { useOffset: false });
  const { PRIORITY } = sequencer();
  const { geometry } = require('./sequencer/geometry');
  const effects = plan.effects.map(e => ({
    el: e.el, layer: PRIORITY.indexOf(e.role) < 0 ? 99 : PRIORITY.indexOf(e.role), start: e.start, end: e.end,
    effect: e.effect, colors: e.colors, brightness: e.brightness,
    settings: Object.fromEntries(Object.entries(e.settings).map(([k, v]) => [k, String(v)])),
  }));
  // picture faces for every prop the plan makes sing, as URLs the browser can load
  const images = require('./sequencer/images');
  const showDir = getSetting('showDir', '');
  const faces = {};
  for (const e of plan.effects) {
    if (e.effect !== 'Faces' || faces[e.el]) continue;
    const def = plan.layout.models.find(m => m.name === e.el)?.faceDefs?.[e.settings.E_CHOICE_Faces_FaceDefinition];
    if (!def) continue;
    const mouths = {};
    for (const [ph, saved] of Object.entries(def.mouths)) {
      if (images.resolve(showDir, saved)) mouths[ph] = `/api/show-image?show=${currentShow()}&p=${encodeURIComponent(saved)}`;
    }
    // `saved` lets the browser find the pictures itself in a show folder chosen in Chrome
    faces[e.el] = { name: e.settings.E_CHOICE_Faces_FaceDefinition, placement: def.placement, mouths, saved: def.mouths };
  }
  res.json({
    faces, showDir: !!showDir,
    seed: plan.seed, fit: plan.fit, duration: plan.analysis.duration, geometry: geometry(plan.layout),
    sections: (plan.analysis.sections || []).map(x => ({ start: x.start, end: x.end, type: x.type })),
    phonemes: plan.analysis.phonemes || [], effects,
    words: (plan.analysis.words || []).map(w => ({ start: w.start, end: w.end, text: w.text })),
    phrases: (plan.analysis.phrases || []).map(p => ({ start: p.start, end: p.end, text: p.text })),
  });
});

app.put('/api/songs/:id/offset', (req, res) => {
  const s = q.get.get(req.params.id);
  if (!s) return res.status(404).json({ error: 'No such song.' });
  const ms = Math.max(-5000, Math.min(5000, Math.round(Number(req.body?.offsetMs) || 0)));
  setSetting(`offset:${s.id}`, ms);
  res.json({ offsetMs: ms });
});

// A face picture from the mounted show folder. Only files found by the image index are
// served, so this can't be used to read anything else on the server.
app.get('/api/show-image', (req, res) => {
  const file = require('./sequencer/images').resolve(getSetting('showDir', ''), String(req.query.p || ''));
  if (!file) return res.status(404).end();
  res.setHeader('Cache-Control', 'max-age=3600');
  res.sendFile(file);
});

app.get('/api/songs/:id/audio', (req, res) => {
  const s = q.get.get(req.params.id);
  if (!s || !fs.existsSync(s.path)) return res.status(404).end();
  res.sendFile(path.resolve(s.path));
});

app.get('/api/songs/:id/xsq', async (req, res) => {
  const s = songReady(req, res);
  if (!s) return;
  const { mediaDir } = layoutState();
  const plan = planFor(s, req.query, await coverFor(s));
  const sep = mediaDir.includes('\\') ? '\\' : '/';
  const mediaFile = mediaDir ? mediaDir.replace(/[\\/]+$/, '') + sep + s.filename : s.filename;
  const { xml, stats } = sequencer().writeXsq({
    analysis: plan.analysis, layout: plan.layout, roles: plan.roles, mediaFile, title: s.title,
    effects: plan.effects, frameMs: Number(process.env.AUTOSEQ_FRAME_MS || 25),
  });
  setSetting(`look:${s.id}`, plan.seed);              // the look you save is the one the song keeps
  console.log(`xsq for ${s.title}: look ${plan.effects.look?.name} (seed ${plan.seed}), fit ${plan.fit.score}`, stats);
  res.setHeader('Content-Type', 'application/xml');
  res.setHeader('Content-Disposition', `attachment; filename="${s.title.replace(/[\\/:*?"<>|]+/g, '_')}.xsq"`);
  res.send(xml);
});

app.delete('/api/songs/:id', (req, res) => {
  const s = q.get.get(req.params.id);
  if (!s) return res.status(404).json({ error: 'No such song.' });
  if (q.samePath.get(s.path, s.id).n === 0) fs.rm(s.path, { force: true }, () => {});   // the song may also be in another show
  // the analysis cache is keyed by audio hash; keep it if another library entry uses the same song
  if (s.result_dir && s.song_hash && q.sameHash.get(s.song_hash, s.id).n === 0) {
    fs.rm(s.result_dir, { recursive: true, force: true }, () => {});
  }
  q.del.run(s.id);
  res.json({ ok: true });
});

app.use((err, req, res, next) => {
  console.error(err);
  res.status(err.status || 500).json({ error: err.message || 'Server error' });
});

app.listen(PORT, () => console.log(`AutoSeq on http://localhost:${PORT} (worker ${WORKER})`));
