#!/usr/bin/env bash
# Swaps in the QMD index that sync-vault.sh sent from the Mac (ADR 0010). Runs on the VM as
# root: stops the API (qmd holds the index open), moves the snapshot and the collection
# config into place, restarts the API and smokes it. The previous index is kept as .previous.
#   sudo /srv/kb-chat/deploy/scripts/install-index.sh
#   sudo /srv/kb-chat/deploy/scripts/install-index.sh --hot
# --hot (KBC-100 FR-5, ADR 0035 §9): the API keeps running. The snapshot is installed under
# its own name (index-<UTC time>.sqlite, so it never shares WAL files with the open one),
# `index.sqlite` becomes a link to it by one rename, and the trigger `reload-index` names it:
# the API starts a new `qmd mcp` on it, reads the vault's catalog again and answers in
# `reload-index.ack`. Searches in flight finish on the old process. Without the ack in
# KB_CHAT_RELOAD_WAIT_S seconds (60; looked for every KB_CHAT_RELOAD_POLL_S, 1), or with a failed smoke, the link goes back to the
# previous index. Older index files are pruned, the previous one kept.
set -euo pipefail

# Read by sync-vault.sh (grep -qx) before it asks for --hot: an install-index.sh without this
# line ignores --hot and restarts the API (KBC-100 review 3). Keep it exactly as it is.
KB_CHAT_INSTALL_INDEX_HOT=1
: "$KB_CHAT_INSTALL_INDEX_HOT"

HOT=0
while [ $# -gt 0 ]; do
  case "$1" in
    --hot) HOT=1; shift ;;
    -h | --help) sed -n '2,13p' "$0"; exit 0 ;;
    *) echo "install-index: unknown option $1" >&2; exit 1 ;;
  esac
done

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

# ---- --hot (KBC-100) ----
TRIGGER="$CACHE/reload-index"
RELOAD_WAIT_S="${KB_CHAT_RELOAD_WAIT_S:-60}"
RELOAD_POLL_S="${KB_CHAT_RELOAD_POLL_S:-1}"

# One rename: a reader opens either the old index or the new one, never none. A link left by
# an interrupted run is replaced (review 4); anything else there makes the swap fail.
point_index_at() {
  rm -f "$CACHE/.index.sqlite.next"
  ln -s "$1" "$CACHE/.index.sqlite.next"
  mv -f "$CACHE/.index.sqlite.next" "$CACHE/index.sqlite"
}

# The API reads the trigger's content; written whole, then renamed.
ask_reload() {
  printf '%s\n' "$1" >"$TRIGGER.next"
  mv -f "$TRIGGER.next" "$TRIGGER"
}

# At least RELOAD_WAIT_S seconds, not a count of polls: the poll can be under a second (tests).
acked() {
  local began=$SECONDS
  while [ $((SECONDS - began)) -le "$RELOAD_WAIT_S" ]; do
    if [ "$(cat "$TRIGGER.ack" 2>/dev/null || true)" = "$1" ]; then return 0; fi
    sleep "$RELOAD_POLL_S"
  done
  return 1
}

# Every index file but the new one and the previous one, with their WAL files; the WAL files
# of a plain index.sqlite once the name is a link.
prune() {
  local keep_new="$1" keep_old="$2" file base
  for file in "$CACHE"/index-*.sqlite; do
    [ -e "$file" ] || continue
    base="$(basename "$file")"
    if [ "$base" = "$keep_new" ] || [ "$base" = "$keep_old" ]; then continue; fi
    rm -f "$file" "$file-wal" "$file-shm"
  done
  rm -f "$CACHE/index.sqlite-wal" "$CACHE/index.sqlite-shm" "$CACHE/index.sqlite.previous"
}

# A swap cut short (set -e, a signal) puts the config and the link back together, so the API
# never reads a new config over the old index (review 4). `changing` while files move. Cut
# short after the API was asked (an SSH hang-up while waiting for its answer), the API is
# asked again for the previous index: it may have taken the new one already (review 3).
HOT_STATE=idle
HOT_PREVIOUS=""
HOT_ASKED=0
# shellcheck disable=SC2329 # invoked by the EXIT trap set in install_hot
undo_hot() {
  [ "$HOT_STATE" = changing ] || return 0
  HOT_STATE=settled
  echo "install-index: the swap stopped half way; putting the previous index and config back" >&2
  if [ -f "$CONFIG/index.yml.previous" ]; then mv -f "$CONFIG/index.yml.previous" "$CONFIG/index.yml" || true; fi
  if [ -n "$HOT_PREVIOUS" ] && [ -e "$CACHE/$HOT_PREVIOUS" ]; then
    # The same single rename as the swap: never a moment without index.sqlite.
    point_index_at "$HOT_PREVIOUS" || true
    if [ "$HOT_ASKED" -eq 1 ]; then ask_reload "$HOT_PREVIOUS" || true; fi
  fi
}

install_hot() {
  local stamp name previous=""
  trap undo_hot EXIT
  # A signal ends the script by exit, so the EXIT trap runs whatever the signal was.
  trap 'exit 129' HUP
  trap 'exit 130' INT
  trap 'exit 143' TERM
  stamp="$(date -u +%Y%m%d%H%M%S)"
  name="index-$stamp.sqlite"
  [ -e "$CACHE/$name" ] && name="index-$stamp-$$.sqlite"
  if [ -L "$CACHE/index.sqlite" ]; then
    previous="$(readlink "$CACHE/index.sqlite")"
  elif [ -f "$CACHE/index.sqlite" ]; then
    # The first hot swap: a second name keeps the open file (the running qmd reads it).
    previous="index-before-$stamp.sqlite"
    ln "$CACHE/index.sqlite" "$CACHE/$previous"
  fi
  HOT_PREVIOUS="$previous"
  # A .previous left by an older run must never be what a rollback puts back.
  rm -f "$CONFIG/index.yml.previous"
  HOT_STATE=changing
  mv -f "$INCOMING/index.sqlite" "$CACHE/$name"
  if [ -f "$CONFIG/index.yml" ]; then cp -f "$CONFIG/index.yml" "$CONFIG/index.yml.previous"; fi
  install -m 0644 "$INCOMING/index.yml" "$CONFIG/index.yml"
  rm -f "$INCOMING/index.yml"
  if [ "$(id -u)" -eq 0 ]; then chown -R "$APP_UID:$APP_UID" "$CACHE" "$CONFIG"; fi
  point_index_at "$name"
  HOT_ASKED=1
  ask_reload "$name"

  if [ ! -f "$DEPLOY_DIR/release.env" ]; then
    HOT_STATE=settled
    echo "install-index: index installed; the first deploy will start the API"
    return 0
  fi
  if acked "$name" && "$DEPLOY_DIR/scripts/smoke.sh"; then
    HOT_STATE=settled
    prune "$name" "$previous"
    echo "install-index: new index live, the API kept running ($name)"
    return 0
  fi

  HOT_STATE=settled
  echo "install-index: the API did not take $name; going back to the previous index" >&2
  if [ -n "$previous" ]; then
    point_index_at "$previous"
    if [ -f "$CONFIG/index.yml.previous" ]; then mv -f "$CONFIG/index.yml.previous" "$CONFIG/index.yml"; fi
    ask_reload "$previous"
  fi
  return 1
}
# ---- end of --hot ----

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
if [ "$HOT" -eq 1 ]; then
  install_hot
  exit 0
fi
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
