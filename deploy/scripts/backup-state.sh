#!/usr/bin/env bash
# Daily encrypted backup of kb-chat's state to OCI Object Storage (ADR 0010, KBC-012).
# Runs on the VM as root from kb-chat-backup.timer. What it saves:
#   state/   conversations, settings (with API keys), spend, usage, people, sessions
#   claude/  the owner's Claude Code login
#   deploy/  .env (secrets), release.env, releases.log
# Not saved: the vault and the QMD index (their source of truth is the owner's Mac).
# The archive is encrypted with age to a public key; the private key never is on the VM.
# Upload uses the instance's own identity (OCI instance principal): no API key on disk.
# Settings (root-owned, /srv/kb-chat/deploy/backup.env):
#   BACKUP_BUCKET=kb-chat-backups  BACKUP_NAMESPACE=<tenancy namespace>
#   BACKUP_AGE_RECIPIENT=age1...   BACKUP_KEEP_DAYS=30
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
KEEP_DAYS="${BACKUP_KEEP_DAYS:-30}"
OCI=(oci --auth instance_principal)
command -v age >/dev/null || die "age is not installed"
command -v zstd >/dev/null || die "zstd is not installed"
command -v jq >/dev/null || die "jq is not installed"

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
tar -C "$ROOT" --create --zstd --file "$work/state.tar.zst" "${paths[@]}"
age --encrypt --recipient "$BACKUP_AGE_RECIPIENT" --output "$work/state.age" "$work/state.tar.zst"
size="$(du -h "$work/state.age" | cut -f1)"

if [ "$DRY_RUN" -eq 1 ]; then
  log "dry run: would upload $object ($size) to $BACKUP_BUCKET"
  tar -tvf "$work/state.tar.zst" | head -n 20
  exit 0
fi

"${OCI[@]}" os object put --namespace "$BACKUP_NAMESPACE" --bucket-name "$BACKUP_BUCKET" \
  --name "$object" --file "$work/state.age" --no-overwrite >/dev/null
log "uploaded $object ($size)"

# Retention: delete state backups older than KEEP_DAYS (the bucket stays far below 20 GB).
cutoff="$(date -u -d "-$KEEP_DAYS days" +%Y%m%dT%H%M%SZ)"
"${OCI[@]}" os object list --namespace "$BACKUP_NAMESPACE" --bucket-name "$BACKUP_BUCKET" \
  --prefix state/kb-chat-state- --all --query 'data[].name' --output json |
  jq -r '.[]' | grep -E '^state/kb-chat-state-' | while read -r name; do
    taken="${name#state/kb-chat-state-}"
    taken="${taken%%.*}"
    if [[ "$taken" < "$cutoff" ]]; then
      "${OCI[@]}" os object delete --namespace "$BACKUP_NAMESPACE" --bucket-name "$BACKUP_BUCKET" \
        --object-name "$name" --force >/dev/null
      log "deleted $name (older than $KEEP_DAYS days)"
    fi
  done
