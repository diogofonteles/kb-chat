#!/usr/bin/env bash
# Daily encrypted backup of kb-chat's state to OCI Object Storage (ADR 0010, KBC-012).
# Runs on the VM as root from kb-chat-backup.timer. What it saves:
#   state/   conversations, settings (with API keys), spend, usage, people, sessions
#   claude/  the owner's Claude Code login
#   deploy/  .env (secrets), release.env, releases.log
# Not saved: the vault and the QMD index (their source of truth is the owner's Mac).
# The archive is encrypted with age to a public key; the private key never is on the VM.
# Upload uses the instance's own identity (OCI instance principal): no API key on disk. The
# VM may only create and list objects: it cannot delete or overwrite a backup, and the
# 30-day retention is the bucket's lifecycle policy (deploy/oci/provision.sh).
# Settings (root-owned, /srv/kb-chat/deploy/backup.env):
#   BACKUP_BUCKET=kb-chat-backups  BACKUP_NAMESPACE=<tenancy namespace>
#   BACKUP_AGE_RECIPIENT=age1...
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

# Paths relative to ROOT, so a restore lands in the same place; missing ones are skipped.
paths=()
for path in state claude deploy/.env deploy/release.env deploy/releases.log; do
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
