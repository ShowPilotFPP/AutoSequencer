// Find the singing-face pictures from the mounted show folder.
//
// xLights stores each picture with the full path on the computer that made it
// (/Users/will/Documents/Light Shows/... or C:\Users\...). On this server the show
// folder is mounted somewhere else, so pictures are found by file name, searching the
// show folder and the folder above it (where other shows' Faces folders often live);
// when two files share a name, the one whose folders match the saved path best wins.
const fs = require('fs');
const path = require('path');

let index = null, indexedFor = null, indexedAt = 0;
const IMG = /\.(png|jpe?g|gif|bmp|webp)$/i;

function build(roots) {
  const byName = new Map();
  let count = 0;
  const walk = (dir, depth) => {
    if (depth > 6 || count > 40000) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p, depth + 1);
      else if (IMG.test(e.name)) {
        count++;
        const k = e.name.toLowerCase();
        if (!byName.has(k)) byName.set(k, []);
        byName.get(k).push(p);
      }
    }
  };
  roots.forEach(r => walk(r, 0));
  return byName;
}

function ensure(showDir) {
  if (!showDir) return null;
  if (index && indexedFor === showDir && Date.now() - indexedAt < 10 * 60 * 1000) return index;
  index = build([...new Set([showDir, path.dirname(showDir)])]);
  indexedFor = showDir; indexedAt = Date.now();
  return index;
}

// saved xLights path → file on this server (or null)
function resolve(showDir, savedPath) {
  const idx = ensure(showDir);
  if (!idx || !savedPath) return null;
  const parts = savedPath.split(/[\\/]+/).filter(Boolean);
  const cands = idx.get(parts[parts.length - 1].toLowerCase());
  if (!cands) return null;
  if (cands.length === 1) return cands[0];
  const score = p => {
    const q = p.split(/[\\/]+/);
    let n = 0;
    while (n < q.length && n < parts.length && q[q.length - 1 - n].toLowerCase() === parts[parts.length - 1 - n].toLowerCase()) n++;
    return n;
  };
  return cands.sort((a, b) => score(b) - score(a))[0];
}

function reset() { index = null; }

module.exports = { resolve, reset };
