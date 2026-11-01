#!/usr/bin/env bash
# One-time: link this AutoSeq install to GitHub so updates come straight from the repo.
#
#   sudo bash setup-github.sh            (run on the AutoSeq server, as root)
#
# 1. Makes a deploy key for this server (read-only access to just this one repo).
# 2. Waits while you add it on GitHub: repo Settings > Deploy keys > Add deploy key.
# 3. Turns /opt/autoseq into a checkout of the newest release. Your data/ folder
#    (songs, settings, analysis), the Python venv, node_modules and bin/ are left alone.
#
# After this, updates are the Update button in AutoSeq's header, or: /opt/autoseq/scripts/update.sh
set -euo pipefail
REPO="ShowPilotFPP/AutoSequencer"
DIR="${AUTOSEQ_DIR:-/opt/autoseq}"
KEY="/root/.ssh/autoseq_deploy"

command -v git >/dev/null || { echo "Installing git"; apt-get update -qq && apt-get install -y -qq git; }
mkdir -p /root/.ssh && chmod 700 /root/.ssh

if [ ! -f "$KEY" ]; then
  ssh-keygen -t ed25519 -N "" -C "autoseq@$(hostname)" -f "$KEY" >/dev/null
  echo "Made a deploy key: $KEY"
fi
ssh-keyscan -t ed25519 github.com 2>/dev/null >> /root/.ssh/known_hosts
sort -u /root/.ssh/known_hosts -o /root/.ssh/known_hosts

SSH="ssh -i $KEY -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new"
until GIT_SSH_COMMAND="$SSH" git ls-remote "git@github.com:$REPO.git" >/dev/null 2>&1; do
  echo
  echo "Add this deploy key on GitHub (leave 'Allow write access' unticked):"
  echo "  https://github.com/$REPO/settings/keys/new"
  echo "  Title: AutoSeq $(hostname)"
  echo
  cat "$KEY.pub"
  echo
  read -r -p "Press Enter once it's added (Ctrl+C to stop)... " _
done
echo "GitHub access works."

cd "$DIR"
if [ ! -d .git ]; then
  git init -q
  git remote add origin "git@github.com:$REPO.git"
fi
git remote set-url origin "git@github.com:$REPO.git"
git config core.sshCommand "$SSH"
git config advice.detachedHead false

# a copy that was unzipped by hand: files in the way of the checkout are replaced by the repo's
git fetch -q --tags --force origin
TARGET="$(git tag -l 'v*' --sort=-v:refname | head -n1)"
[ -n "$TARGET" ] || TARGET="origin/main"
echo "Switching $DIR to $TARGET"
git checkout -q --force --detach "$TARGET"
chmod +x scripts/*.sh

if [ ! -d app/node_modules ]; then (cd app && npm ci --omit=dev --no-audit --no-fund); fi
if command -v pm2 >/dev/null; then pm2 restart autoseq --update-env >/dev/null && echo "Restarted AutoSeq."; fi
echo
echo "Done: AutoSeq is on $(git describe --tags --always) and will update from GitHub."
echo "Use the version button in AutoSeq's header, or run $DIR/scripts/update.sh"
