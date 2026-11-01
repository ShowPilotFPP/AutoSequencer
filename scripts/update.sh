#!/usr/bin/env bash
# AutoSeq updater: bring this install up to the newest release on GitHub.
#
#   scripts/update.sh            newest release tag (v1.2.3)
#   scripts/update.sh v1.0.4     a specific release (to roll back)
#   scripts/update.sh main       the latest commit on main, released or not
#
# Your songs, settings and analysis live in data/ (not in git), so they're never touched.
# Only what changed gets rebuilt: Node packages when app/package*.json changed, Python
# packages when worker/requirements.txt changed, and the worker restarts only when
# worker/ changed.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
mkdir -p data
LOG="$ROOT/data/update.log"
exec > >(tee -a "$LOG") 2>&1
echo
echo "=== $(date '+%F %T') update starting"

git fetch --quiet --tags --force --prune origin
TARGET="${1:-latest}"
if [ "$TARGET" = "latest" ]; then
  TARGET="$(git tag -l 'v*' --sort=-v:refname | head -n1)"
  [ -n "$TARGET" ] || TARGET="origin/main"
elif [ "$TARGET" = "main" ]; then
  TARGET="origin/main"
fi

OLD="$(git rev-parse HEAD 2>/dev/null || echo none)"
NEW="$(git rev-parse "$TARGET^{commit}")"
if [ "$OLD" = "$NEW" ]; then
  echo "Already on $TARGET ($(git describe --tags --always)). Nothing to do."
  echo "=== done"
  exit 0
fi

echo "Updating $(git describe --tags --always 2>/dev/null || echo '?') -> $TARGET"
git checkout --quiet --force --detach "$NEW"
if [ "$OLD" = "none" ]; then CHANGED="$(git ls-files)"; else CHANGED="$(git diff --name-only "$OLD" "$NEW")"; fi

if echo "$CHANGED" | grep -q '^app/package\(-lock\)\?\.json$' || [ ! -d app/node_modules ]; then
  echo "Node packages changed: installing"
  (cd app && (npm ci --omit=dev --no-audit --no-fund || npm install --omit=dev --no-audit --no-fund))
fi
if echo "$CHANGED" | grep -q '^worker/requirements\.txt$' && [ -x worker/.venv/bin/pip ]; then
  echo "Python packages changed: installing"
  worker/.venv/bin/pip install -q -r worker/requirements.txt
fi
chmod +x scripts/*.sh 2>/dev/null || true

if command -v pm2 >/dev/null; then
  if echo "$CHANGED" | grep -q '^worker/'; then
    echo "Restarting the analysis worker"
    pm2 restart autoseq-worker --update-env >/dev/null || echo "(worker restart failed: check pm2 logs autoseq-worker)"
  fi
  echo "Restarting the app"
  echo "=== $(date '+%F %T') now on $(git describe --tags --always)"
  pm2 restart autoseq --update-env >/dev/null
else
  echo "pm2 not found: restart AutoSeq yourself."
  echo "=== $(date '+%F %T') now on $(git describe --tags --always)"
fi
