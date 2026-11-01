// Updates from GitHub (ShowPilotFPP/AutoSequencer).
//
// GET  /api/update      what's installed, the newest release, and what changed
// POST /api/update      install the latest version (runs scripts/update.sh, which restarts the app)
// GET  /api/update/log  the end of data/update.log
//
// The install is a git checkout of /opt/autoseq that follows main on GitHub, reached with a
// read-only deploy key (set up once by scripts/setup-github.sh). A change is "released" by
// merging it into main. The version shown is the newest tag plus commits since (v1.0.0-3-gabc123).
const path = require('path');
const fs = require('fs');
const { execFile, spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const SCRIPT = path.join(ROOT, 'scripts', 'update.sh');
const LOG = path.join(ROOT, 'data', 'update.log');

const git = (args, timeout = 30000) => new Promise((resolve, reject) =>
  execFile('git', args, { cwd: ROOT, timeout }, (err, out, errOut) => (err ? reject(new Error((errOut || err.message).trim())) : resolve(out.trim()))));

const isRepo = () => fs.existsSync(path.join(ROOT, '.git'));

async function current() {
  if (!isRepo()) return { installed: null, commit: null };
  const commit = await git(['rev-parse', '--short', 'HEAD']).catch(() => null);
  const installed = await git(['describe', '--tags', '--always']).catch(() => commit);
  return { installed, commit };
}

let lastCheck = null;          // cached for 10 minutes so page loads don't hit GitHub every time
async function check(force = false) {
  if (!isRepo()) return { ok: false, reason: 'not-git', message: 'This install isn’t linked to GitHub yet. Run scripts/setup-github.sh on the server once.' };
  if (!force && lastCheck && Date.now() - lastCheck.at < 10 * 60 * 1000) return { ...lastCheck.result, ...(await current()) };
  const cur = await current();
  try {
    await git(['fetch', '--quiet', '--tags', '--force', 'origin'], 60000);
  } catch (e) {
    return { ok: false, reason: 'fetch', message: `Couldn’t reach GitHub: ${e.message.split('\n').pop()}`, ...cur };
  }
  const head = await git(['rev-parse', 'HEAD']);
  const tip = await git(['rev-parse', 'origin/main']).catch(() => null);
  if (!tip) return { ok: false, reason: 'fetch', message: 'GitHub has no main branch yet.', ...cur };
  const latest = await git(['describe', '--tags', '--always', 'origin/main']).catch(() => tip.slice(0, 7));
  // behind = main has commits this install doesn't (a rolled-back install is behind too)
  const ahead = Number(await git(['rev-list', '--count', `${head}..${tip}`]).catch(() => 0));
  const behind = head !== tip && ahead > 0;
  const changes = behind ? (await git(['log', '--format=%s', '--no-merges', '-n', '30', `${head}..${tip}`]).catch(() => ''))
    .split('\n').filter(Boolean) : [];
  const notes = '';
  const result = { ok: true, latest, behind, changes, notes: notes.trim(), checkedAt: new Date().toISOString() };
  lastCheck = { at: Date.now(), result };
  return { ...result, ...cur };
}

let running = false;
function install(target = 'latest') {
  if (running) return { started: false, message: 'An update is already running.' };
  if (!isRepo()) return { started: false, message: 'This install isn’t linked to GitHub yet.' };
  if (!/^(latest|main|v[\w.-]+|[0-9a-f]{7,40})$/.test(target)) return { started: false, message: 'Unknown release.' };
  running = true;
  // nohup + background, through a shell that exits at once: the script is re-parented away
  // from this process, so it survives the restart it triggers at the end
  spawn('bash', ['-c', `nohup bash "${SCRIPT}" "${target}" >/dev/null 2>&1 &`], { cwd: ROOT, detached: true, stdio: 'ignore' }).unref();
  lastCheck = null;
  return { started: true };
}

function tail(lines = 60) {
  try { return fs.readFileSync(LOG, 'utf8').split('\n').slice(-lines).join('\n'); } catch { return ''; }
}

function routes(app) {
  app.get('/api/update', async (req, res) => {
    try { res.json(await check(req.query.force === '1')); } catch (e) { res.json({ ok: false, reason: 'error', message: e.message }); }
  });
  app.post('/api/update', (req, res) => res.json(install(String(req.body?.target || 'latest'))));
  app.get('/api/update/log', (req, res) => res.type('text/plain').send(tail(Number(req.query.lines) || 60)));
  app.get('/api/version', async (req, res) => res.json(await current()));
}

module.exports = { routes, check, current };
