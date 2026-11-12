#!/usr/bin/env bash
# Imports a media package from the owner's Mac into production (KBC-116, ADR 0038). The
# package arrives by push-media.sh (rsync to /srv/kb-chat/media-inbox/package); this script
# checks every sha256, then runs the import in a one-off container of the API image:
#   sudo /srv/kb-chat/deploy/scripts/import-media.sh <package-dir> --dry-run   # API up, nothing changes
#   sudo /srv/kb-chat/deploy/scripts/import-media.sh <package-dir>             # API stopped meanwhile
#   sudo /srv/kb-chat/deploy/scripts/import-media.sh --verify                  # the check, read only
# The real run first keeps media/backup/media.db.before-import-<stamp> and
# state/authors.json.before-import-<stamp>, the last $KEEP of each (rollback: runbook §9f).
# The package stays in the inbox for the next rsync, readable by root and the app's group
# only. Exit: 0 done, 3 something held (listed), 1 failure, 2 wrong usage.
set -euo pipefail

ROOT="${KB_CHAT_ROOT:-/srv/kb-chat}"
DEPLOY_DIR="$ROOT/deploy"
APP_UID="${KB_CHAT_APP_UID:-10001}"
KEEP="${KB_CHAT_IMPORT_KEEP:-5}"

log() { printf '%s import-media: %s\n' "$(date -u +%FT%TZ)" "$*"; }
die() { log "$*" >&2; exit 1; }
usage() { echo "usage: import-media.sh <package-dir> [--dry-run] | --verify" >&2; exit 2; }

env_value() {
  sed -n "s/^$1=//p" "$DEPLOY_DIR/.env" 2>/dev/null | tail -n 1 | tr -d "\"' "
}

# The folders compose mounts into the API (KB_CHAT_DATA, default the deploy's root, QA F-5):
# the import writes where the API reads.
DATA="$(env_value KB_CHAT_DATA)"
DATA="${DATA:-$ROOT}"
MEDIA="$DATA/media"
STATE="$DATA/state"

compose() {
  docker compose --project-directory "$DEPLOY_DIR" -f "$DEPLOY_DIR/compose.yml" \
    --env-file "$DEPLOY_DIR/.env" --env-file "$DEPLOY_DIR/release.env" "$@"
}

take_lock() {
  [ -n "${KB_CHAT_LOCKED:-}" ] && return 0
  command -v flock >/dev/null || return 0
  exec 9>"$DEPLOY_DIR/.lock"
  flock -w 300 9 || die "another deploy holds $DEPLOY_DIR/.lock"
  export KB_CHAT_LOCKED=1
}

# The media library must be on (runbook §9d) and its folder the app's: the import writes there.
check_media() {
  grep -Eq "^KB_CHAT_MEDIA=[\"']?on" "$DEPLOY_DIR/.env" || die "the media library is off: turn it on first (runbook §9d)"
  [ -n "$(find "$MEDIA" -maxdepth 0 -uid "$APP_UID" -perm 0700 2>/dev/null)" ] ||
    die "$MEDIA must be owned by uid $APP_UID with mode 0700 (runbook §9d)"
}

# The image the API runs: the import is the same release's code (BR-9).
api_image() {
  compose config --images | grep -m1 '/kb-chat-api:' || die "no kb-chat-api image in compose.yml"
}

owner_email() { env_value KB_CHAT_OWNER_EMAIL; }

# A one-off container: no network, read-only root, the media folder, the state folder (read
# only in a dry run: the kernel keeps "nothing changes"), the vault and the package read-only.
# Nothing from .env but the owner's e-mail (not a secret).
transfer() {
  local package="$1" state="$2"
  shift 2
  docker run --rm --network none --read-only --tmpfs /tmp:rw,size=512m \
    --user "$APP_UID:$APP_UID" --cap-drop ALL --security-opt no-new-privileges \
    -e KB_CHAT_OWNER_EMAIL="$(owner_email)" -e KB_CHAT_MEDIA_DIR=/data/media \
    -e KB_CHAT_STATE_DIR=/data/state -e KB_VAULT=/vault \
    -v "$MEDIA:/data/media" -v "$STATE:/data/state$state" -v "$DATA/vault:/vault:ro" \
    -v "$package:/import:ro" "$(api_image)" node dist/media-transfer-main.js "$@"
}

# The package holds people's progress and e-mails: root and the app's group only (QA F-1).
seal_package() {
  { chgrp -R "$APP_UID" "$1" && chmod -R u=rwX,g=rX,o= "$1"; } ||
    die "could not give $1 to the app's group only"
}

check_package() {
  local package="$1"
  [ -f "$package/SHA256SUMS" ] || die "$package has no SHA256SUMS (send it with push-media.sh)"
  (cd "$package" && sha256sum --quiet --strict -c SHA256SUMS) || die "the package does not match its checksums: nothing changed"
}

# Keeps the newest $KEEP files of <dir> named <prefix><stamp> (stamps sort by time).
prune_kept() {
  local dir="$1" prefix="$2" old
  [ -d "$dir" ] || return 0
  find "$dir" -maxdepth 1 -type f -name "$prefix*" -print | sort -r | tail -n +"$((KEEP + 1))" |
    while IFS= read -r old; do rm -f -- "$old"; done
}

# The rollback point: the media database as it is now, and production's authors. Called
# under ||, where set -e is off: every step returns its own failure.
keep_rollback_point() {
  local stamp="$1"
  if [ -f "$STATE/authors.json" ]; then
    cp -p "$STATE/authors.json" "$STATE/authors.json.before-import-$stamp" || return 1
    prune_kept "$STATE" authors.json.before-import- || return 1
  fi
  [ -f "$MEDIA/media.db" ] || return 0
  install -d -o "$APP_UID" -g "$APP_UID" -m 0700 "$MEDIA/backup" || return 1
  docker run --rm --network none --user "$APP_UID:$APP_UID" -v "$MEDIA:/data/media" "$(api_image)" \
    node -e "const { DatabaseSync } = require('node:sqlite');
      const db = new DatabaseSync('/data/media/media.db', { readOnly: true });
      db.prepare('VACUUM INTO ?').run('/data/media/backup/media.db.before-import-$stamp');
      db.close();" || return 1
  prune_kept "$MEDIA/backup" media.db.before-import- || return 1
  log "rollback point: media/backup/media.db.before-import-$stamp"
}

main() {
  [ $# -ge 1 ] || usage
  [ "$(id -u)" -eq 0 ] || die "run with sudo"
  if [ "$1" = "--verify" ]; then
    [ $# -eq 1 ] || usage
    compose exec -T api node dist/media-transfer-main.js verify
    return
  fi
  local package dry=""
  package="$(cd "$1" && pwd)" || usage
  if [ $# -eq 2 ] && [ "$2" = "--dry-run" ]; then dry="--dry-run"; elif [ $# -ne 1 ]; then usage; fi
  check_media
  check_package "$package"
  seal_package "$package"
  take_lock
  if [ -n "$dry" ]; then
    transfer "$package" :ro import --package /import --dry-run
    return
  fi
  import_stopped "$package"
}

# The real run: the API is the single writer of media.db (ADR 0022), so it stops meanwhile.
import_stopped() {
  local package="$1" stamp code=0
  stamp="$(date -u +%Y%m%dT%H%M%SZ)"
  compose stop api media-worker
  keep_rollback_point "$stamp" || {
    log "could not keep the rollback point: nothing changed"
    compose up -d --wait --wait-timeout 180 || true
    exit 1
  }
  transfer "$package" "" import --package /import | tee "$DEPLOY_DIR/media-import-$stamp.log" || code=$?
  compose up -d --wait --wait-timeout 180 || die "the stack did not come back after the import (code $code)"
  "$DEPLOY_DIR/scripts/smoke.sh" || die "smoke failed after the import (code $code)"
  log "done (code $code; report in $DEPLOY_DIR/media-import-$stamp.log)"
  return "$code"
}

main "$@"
