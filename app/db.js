// SQLite library of songs and their analysis jobs.
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const DATA_DIR = path.resolve(process.env.AUTOSEQ_DATA_DIR || path.join(__dirname, '..', 'data'));
fs.mkdirSync(path.join(DATA_DIR, 'uploads'), { recursive: true });

const db = new Database(path.join(DATA_DIR, 'autoseq.db'));
db.pragma('journal_mode = WAL');
db.exec(`
CREATE TABLE IF NOT EXISTS songs (
  id          TEXT PRIMARY KEY,
  title       TEXT NOT NULL,
  filename    TEXT NOT NULL,
  path        TEXT NOT NULL,
  size        INTEGER,
  status      TEXT NOT NULL DEFAULT 'queued',   -- queued | running | done | error
  stage       TEXT DEFAULT 'queued',
  pct         INTEGER DEFAULT 0,
  worker_job  TEXT,
  separate    INTEGER DEFAULT 1,
  lyrics      TEXT,
  song_hash   TEXT,
  result_dir  TEXT,
  summary     TEXT,
  log         TEXT DEFAULT '[]',
  error       TEXT,
  created_at  TEXT DEFAULT (datetime('now')),
  updated_at  TEXT DEFAULT (datetime('now'))
);`);

db.exec(`CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);`);

// ---- shows: each show (Halloween, Christmas, ...) has its own layout, roles, folder and
// looks. Show-level settings are stored as "show:<id>:<key>"; the show for a request is
// carried with AsyncLocalStorage, so code just calls getSetting('roles') as before.
const { AsyncLocalStorage } = require('async_hooks');
const showCtx = new AsyncLocalStorage();
const SHOW_KEYS = new Set(['layout', 'roles', 'face', 'theme', 'mediaDir', 'showDir', 'showMtime', 'indoor', 'shaders', 'shaderAmount']);
const rawGet = (k, d = null) => {
  const r = db.prepare('SELECT value FROM settings WHERE key = ?').get(k);
  return r ? JSON.parse(r.value) : d;
};
const rawSet = (k, v) => db.prepare(`INSERT INTO settings (key, value) VALUES (?, ?)
  ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(k, JSON.stringify(v));
const currentShow = () => showCtx.getStore()?.show || 'halloween';
const keyFor = k => (SHOW_KEYS.has(k) ? `show:${currentShow()}:${k}` : k);
const getSetting = (k, d = null) => rawGet(keyFor(k), d);
const setSetting = (k, v) => rawSet(keyFor(k), v);

// songs belong to a show (older songs: Halloween)
try { db.exec(`ALTER TABLE songs ADD COLUMN show_id TEXT DEFAULT 'halloween'`); } catch { /* already there */ }

// first run with shows: the existing setup becomes the Halloween show, and a Christmas one is added
if (!rawGet('shows')) {
  for (const k of SHOW_KEYS) {
    const v = rawGet(k);
    if (v !== null) rawSet(`show:halloween:${k}`, v);
  }
  rawSet('shows', [{ id: 'halloween', name: 'Halloween', kind: 'halloween' }, { id: 'christmas', name: 'Christmas', kind: 'christmas' }]);
}

const q = {
  insert: db.prepare(`INSERT INTO songs (id, title, filename, path, size, separate, lyrics, show_id)
                      VALUES (@id, @title, @filename, @path, @size, @separate, @lyrics, @show_id)`),
  get: db.prepare('SELECT * FROM songs WHERE id = ?'),
  list: db.prepare(`SELECT id, title, filename, status, stage, pct, summary, created_at, updated_at, show_id
                    FROM songs WHERE show_id = ? ORDER BY created_at DESC`),
  allActive: db.prepare(`SELECT id, title, status, stage, pct, show_id FROM songs WHERE status IN ('queued','running')`),
  samePath: db.prepare('SELECT COUNT(*) AS n FROM songs WHERE path = ? AND id != ?'),
  active: db.prepare(`SELECT * FROM songs WHERE status IN ('queued','running')`),
  sameHash: db.prepare('SELECT COUNT(*) AS n FROM songs WHERE song_hash = ? AND id != ?'),
  del: db.prepare('DELETE FROM songs WHERE id = ?'),
};

function update(id, fields) {
  const keys = Object.keys(fields);
  if (!keys.length) return;
  const set = keys.map(k => `${k} = @${k}`).join(', ');
  db.prepare(`UPDATE songs SET ${set}, updated_at = datetime('now') WHERE id = @id`).run({ ...fields, id });
}

function shape(row) {
  if (!row) return null;
  return {
    ...row,
    separate: !!row.separate,
    summary: row.summary ? JSON.parse(row.summary) : null,
    log: row.log ? JSON.parse(row.log) : [],
  };
}

module.exports = { db, q, update, shape, DATA_DIR, getSetting, setSetting, rawGet, rawSet, showCtx, currentShow };
