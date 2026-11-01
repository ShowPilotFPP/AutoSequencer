#!/usr/bin/env bash
# One-time setup on Ubuntu 22.04/24.04 (LXC or VM). Safe to re-run.
#   bash setup_ubuntu.sh
set -euo pipefail
cd "$(dirname "$0")"
ROOT="$PWD"
SUDO=""; [ "$(id -u)" -ne 0 ] && SUDO="sudo"

echo "== system packages"
$SUDO apt-get update -qq
$SUDO apt-get install -y -qq ffmpeg curl unzip git build-essential ca-certificates >/dev/null

if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 20 ]; then
  echo "== Node 22 (NodeSource)"
  curl -fsSL https://deb.nodesource.com/setup_22.x | $SUDO -E bash - >/dev/null
  $SUDO apt-get install -y -qq nodejs >/dev/null
fi
command -v pm2 >/dev/null || $SUDO npm install -g pm2 >/dev/null

echo "== Python 3.11 worker (via uv — leaves the system Python alone)"
if ! command -v uv >/dev/null; then
  curl -LsSf https://astral.sh/uv/install.sh | sh >/dev/null
  export PATH="$HOME/.local/bin:$PATH"
fi
cd worker
[ -d .venv ] || uv venv --python 3.11 .venv
uv pip install --python .venv/bin/python --index-strategy unsafe-best-match -r requirements.txt
echo "== basic-pitch (note tracks — optional)"
uv pip install --python .venv/bin/python --index-strategy unsafe-best-match "basic-pitch[onnx]" \
  || uv pip install --python .venv/bin/python --index-strategy unsafe-best-match basic-pitch \
  || echo "!! basic-pitch didn't install — everything works except the per-instrument note tracks"
echo "== DrumSep model (splits the drum stem into kick / snare / cymbals / toms)"
.venv/bin/python -c "from autoseq import kit; print('DrumSep ready:', kit.ensure_model() or 'NOT downloaded — drums fall back to the plain drum stem')"
cd "$ROOT"

echo "== Rhubarb Lip Sync"
if [ ! -x bin/rhubarb/rhubarb ]; then
  url=$(curl -s https://api.github.com/repos/DanielSWolf/rhubarb-lip-sync/releases/latest \
        | grep -o '"browser_download_url": *"[^"]*Linux[^"]*\.zip"' | head -1 | cut -d'"' -f4)
  if [ -n "$url" ]; then
    mkdir -p bin && curl -sL "$url" -o /tmp/rhubarb.zip && unzip -qo /tmp/rhubarb.zip -d bin
    mv bin/Rhubarb-Lip-Sync-*-Linux bin/rhubarb 2>/dev/null || true
    chmod +x bin/rhubarb/rhubarb 2>/dev/null || true
  else
    echo "!! couldn't find a Rhubarb Linux release — lip sync falls back to dictionary timing"
  fi
fi

echo "== Node app"
(cd app && npm install --omit=dev --no-audit --no-fund)

echo "== PM2"
pm2 startOrReload ecosystem.config.js
pm2 save
echo
echo "AutoSeq is on http://$(hostname -I | awk '{print $1}'):3075"
echo "First song downloads the models (~2 GB). Logs: pm2 logs autoseq-worker"
