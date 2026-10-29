#!/usr/bin/env bash
# Daily encrypted backup of kb-chat's state to OCI Object Storage (ADR 0010, KBC-012).
# Runs on the VM as root from kb-chat-backup.timer. What it saves:
#   state/   conversations, settings (with API keys), spend, usage, people, sessions
#   claude/  the owner's Claude Code login
#   codex/   the owner's Codex login (KBC-027, ADR 0020)
#   deploy/  .env (secrets), release.env, releases.log
#   media/backup/media.db  a consistent snapshot of the media database (ADR 0022), taken by
#            the API container (`VACUUM INTO`); never the audio files (re-creatable).
# Not saved: the vault and the QMD index (their source of truth is the owner's Mac).
# The archive is encrypted with age to a public key; the private key never is on the VM.
# Upload uses the instance's own identity (OCI instance principal): no API key on disk. The
# VM may only create and list objects: it cannot delete or overwrite a backup, and the
# 30-day retention is the bucket's lifecycle policy (deploy/oci/provision.sh).
# Settings (root-owned, /srv/kb-chat/deploy/backup.env):
#   BACKUP_BUCKET=kb-chat-backups  BACKUP_NAMESPACE=<tenancy namespace>
#   BACKUP_AGE_RECIPIENT=age1...
#   BACKUP_REGION=sa-saopaulo-1    BACKUP_COMPARTMENT_OCID=ocid1.compartment...   (the alarm metric)
# Health: success writes "ok <time>" to deploy/backup-status and posts the backup_success
# metric (an OCI absence alarm e-mails the owner when it stops); a failure is recorded by
# kb-chat-backup-failed.service (OnFailure=). deploy.sh --status reports both.
#   sudo backup-state.sh [--dry-run]
set -euo pipefail

ROOT="${KB_CHAT_ROOT:-/srv/kb-chat}"
SETTINGS="$ROOT/deploy/backup.env"
DRY_RUN=0
[ "${1:-}" = "--dry-run" ] && DRY_RUN=1

die() { echo "backup: $*" >&2; exit 1; }
log() { printf '%s backup: %s\n' "$(date -u +%FT%TZ)" "$*"; }

[ -f "$SETTINGS" ] || die "missing $SETTINGS"
# shellcheck source=/dev/null
. "$SETTINGS"
: "${BACKUP_BUCKET:?}" "${BACKUP_NAMESPACE:?}" "${BACKUP_AGE_RECIPIENT:?}"
OCI=(oci --auth instance_principal)
command -v age >/dev/null || die "age is not installed"
command -v zstd >/dev/null || die "zstd is not installed"

stamp="$(date -u +%Y%m%dT%H%M%SZ)"
object="state/kb-chat-state-$stamp.tar.zst.age"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

# The media database: a snapshot taken inside the API container, where node:sqlite is.
snapshot_media() {
  [ -f "$ROOT/media/media.db" ] || return 0
  local api
  api="$(docker ps -q -f label=com.docker.compose.project=kb-chat -f label=com.docker.compose.service=api | head -n 1)"
  [ -n "$api" ] || die "the media database exists but the api container is not running"
  docker exec "$api" node --disable-warning=ExperimentalWarning -e "
    const fs = require('node:fs');
    const { DatabaseSync } = require('node:sqlite');
    fs.mkdirSync('/data/media/backup', { recursive: true });
    fs.rmSync('/data/media/backup/media.db', { force: true });
    const db = new DatabaseSync('/data/media/media.db', { readOnly: true });
    db.exec(\"VACUUM INTO '/data/media/backup/media.db'\");
    db.close();
  " || die "could not snapshot the media database"
}
snapshot_media

# Paths relative to ROOT, so a restore lands in the same place; missing ones are skipped.
paths=()
for path in state claude codex media/backup/media.db deploy/.env deploy/release.env deploy/releases.log; do
  if [ -e "$ROOT/$path" ]; then paths+=("$path"); fi
done
[ "${#paths[@]}" -gt 0 ] || die "nothing to back up under $ROOT"
# Streamed straight into age: the plaintext archive (with .env) never touches the disk.
# State files are written atomically (temp + rename); a .jsonl may end in a partial line,
# which the readers skip.
tar -C "$ROOT" --create --zstd --file - "${paths[@]}" |
  age --encrypt --recipient "$BACKUP_AGE_RECIPIENT" --output "$work/state.age"
size="$(du -h "$work/state.age" | cut -f1)"

if [ "$DRY_RUN" -eq 1 ]; then
  log "dry run: would upload $object ($size) to $BACKUP_BUCKET with:"
  printf '  %s\n' "${paths[@]}"
  exit 0
fi

"${OCI[@]}" os object put --namespace "$BACKUP_NAMESPACE" --bucket-name "$BACKUP_BUCKET" \
  --name "$object" --file "$work/state.age" --no-overwrite >/dev/null
log "uploaded $object ($size)"

date -u +"ok %Y-%m-%dT%H:%M:%SZ" >"$ROOT/deploy/backup-status"

# The heartbeat of the absence alarm (deploy/oci/provision.sh). Best effort: if it cannot be
# posted, the alarm fires, which is the right signal.
if [ -n "${BACKUP_REGION:-}" ] && [ -n "${BACKUP_COMPARTMENT_OCID:-}" ]; then
  metric="$(printf '[{"namespace":"kb_chat","compartmentId":"%s","name":"backup_success","dimensions":{"resourceId":"kb-chat-vm"},"datapoints":[{"timestamp":"%s","value":1}]}]' \
    "$BACKUP_COMPARTMENT_OCID" "$(date -u +%Y-%m-%dT%H:%M:%SZ)")"
  "${OCI[@]}" monitoring metric-data post --metric-data "$metric" \
    --endpoint "https://telemetry-ingestion.$BACKUP_REGION.oraclecloud.com" >/dev/null ||
    log "could not post the backup_success metric; the absence alarm will fire"
else
  log "BACKUP_REGION/BACKUP_COMPARTMENT_OCID unset: no heartbeat for the absence alarm"
fi
