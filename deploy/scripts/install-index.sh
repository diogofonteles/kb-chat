#!/usr/bin/env bash
# Swaps in the QMD index that sync-vault.sh sent from the Mac (ADR 0010). Runs on the VM as
# root: stops the API (qmd holds the index open), moves the snapshot and the collection
# config into place, restarts the API and smokes it. The previous index is kept as .previous.
#   sudo /srv/kb-chat/deploy/scripts/install-index.sh
set -euo pipefail

ROOT="${KB_CHAT_ROOT:-/srv/kb-chat}"
DEPLOY_DIR="$ROOT/deploy"
INCOMING="$ROOT/qmd/incoming"
CACHE="$ROOT/qmd/cache"
CONFIG="$ROOT/qmd/config"
APP_UID=10001

die() { echo "install-index: $*" >&2; exit 1; }

[ -f "$INCOMING/index.sqlite" ] || die "nothing to install in $INCOMING"
[ -f "$INCOMING/index.yml" ] || die "missing $INCOMING/index.yml"
head -c 15 "$INCOMING/index.sqlite" | grep -q '^SQLite format 3' || die "index.sqlite is not a SQLite database"
grep -q '^collections:' "$INCOMING/index.yml" || die "index.yml has no collections"
if grep -E '^ +path: ' "$INCOMING/index.yml" | grep -vqE '^ +path: /vault/'; then
  die "index.yml points outside /vault"
fi

compose() {
  docker compose --project-directory "$DEPLOY_DIR" -f "$DEPLOY_DIR/compose.yml" \
    --env-file "$DEPLOY_DIR/.env" --env-file "$DEPLOY_DIR/release.env" "$@"
}

# The same lock as deploy.sh: never swap the index while a release is changing.
if [ -z "${KB_CHAT_LOCKED:-}" ] && command -v flock >/dev/null; then
  exec 9>"$DEPLOY_DIR/.lock"
  flock -w 300 9 || die "another deploy holds $DEPLOY_DIR/.lock"
  export KB_CHAT_LOCKED=1
fi

mkdir -p "$CACHE" "$CONFIG"
# Before the first deploy there is no release yet: just put the files in place.
running=0
if [ -f "$DEPLOY_DIR/release.env" ]; then
  running=1
  compose stop api
fi
if [ -f "$CACHE/index.sqlite" ]; then
  mv -f "$CACHE/index.sqlite" "$CACHE/index.sqlite.previous"
fi
if [ -f "$CONFIG/index.yml" ]; then
  cp -f "$CONFIG/index.yml" "$CONFIG/index.yml.previous"
fi
rm -f "$CACHE/index.sqlite-wal" "$CACHE/index.sqlite-shm"
mv -f "$INCOMING/index.sqlite" "$CACHE/index.sqlite"
install -m 0644 "$INCOMING/index.yml" "$CONFIG/index.yml"
rm -f "$INCOMING/index.yml"
if [ "$(id -u)" -eq 0 ]; then chown -R "$APP_UID:$APP_UID" "$CACHE" "$CONFIG"; fi

if [ "$running" -eq 0 ]; then
  echo "install-index: index installed; the first deploy will start the API"
  exit 0
fi
if compose up -d --wait --wait-timeout 180 api web && "$DEPLOY_DIR/scripts/smoke.sh"; then
  echo "install-index: new index live"
  exit 0
fi

# The new index does not pass: put the previous one back so search keeps working.
echo "install-index: the new index failed the smoke; restoring the previous one" >&2
if [ -f "$CACHE/index.sqlite.previous" ]; then
  compose stop api || true
  rm -f "$CACHE/index.sqlite-wal" "$CACHE/index.sqlite-shm"
  mv -f "$CACHE/index.sqlite.previous" "$CACHE/index.sqlite"
  if [ -f "$CONFIG/index.yml.previous" ]; then mv -f "$CONFIG/index.yml.previous" "$CONFIG/index.yml"; fi
  compose up -d --wait --wait-timeout 180 api web || true
fi
exit 1
