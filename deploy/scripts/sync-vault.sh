#!/usr/bin/env bash
# Sends the kb vault and its QMD index from the owner's Mac to the VM over SSH (ADR 0010).
# The vault never goes through GitHub. Run on the Mac, after `kb ingest`/`qmd embed`:
#   deploy/scripts/sync-vault.sh --host ubuntu@kb.example.com --dry-run   # see what changes
#   deploy/scripts/sync-vault.sh --host ubuntu@kb.example.com             # send it
# Options:
#   --vault <dir>      vault root with kb.toml (default ~/dev/personal/hermetismo)
#   --index <file>     QMD index (default ~/.cache/qmd/index.sqlite)
#   --with-models      also send the QMD models (~2 GB; otherwise the VM downloads them once)
#   --max-delete <n>   refuse when rsync would delete more than n vault files (default 200)
#   --dry-run          list the changes, send nothing
# Safeguards: the source must be a kb vault with at least one topic; deletions on the VM are
# capped; the index is copied as a consistent SQLite snapshot and swapped in atomically by
# install-index.sh on the VM, which restarts the API.
set -euo pipefail

VAULT="${KB_VAULT:-$HOME/dev/personal/hermetismo}"
INDEX="$HOME/.cache/qmd/index.sqlite"
MODELS="$HOME/.cache/qmd/models"
QMD_CONFIG="${XDG_CONFIG_HOME:-$HOME/.config}/qmd/index.yml"
HOST="${KB_CHAT_HOST:-}"
REMOTE_ROOT="${KB_CHAT_REMOTE_ROOT:-/srv/kb-chat}"
MAX_DELETE=200
DRY_RUN=0
WITH_MODELS=0

die() { echo "sync-vault: $*" >&2; exit 1; }

while [ $# -gt 0 ]; do
  case "$1" in
    --host) HOST="${2:-}"; shift 2 ;;
    --vault) VAULT="${2:-}"; shift 2 ;;
    --index) INDEX="${2:-}"; shift 2 ;;
    --max-delete) MAX_DELETE="${2:-}"; shift 2 ;;
    --with-models) WITH_MODELS=1; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h | --help) sed -n '2,16p' "$0"; exit 0 ;;
    *) die "unknown option $1" ;;
  esac
done

[ -n "$HOST" ] || die "--host user@host is required (or KB_CHAT_HOST)"
[[ "$MAX_DELETE" =~ ^[0-9]+$ ]] || die "--max-delete must be a number"
VAULT="${VAULT%/}"
[ -f "$VAULT/kb.toml" ] || die "$VAULT is not a kb vault (no kb.toml)"
topics="$(find "$VAULT" -mindepth 2 -maxdepth 2 -name topic.yaml -not -path '*/_*' | wc -l | tr -d ' ')"
[ "$topics" -gt 0 ] || die "$VAULT has no topic (no */topic.yaml); refusing to sync an empty vault"
[ -f "$INDEX" ] || die "no QMD index at $INDEX (run qmd update && qmd embed)"
command -v sqlite3 >/dev/null || die "sqlite3 is required for a consistent index snapshot"

# QMD's collection config with the Mac paths moved to the container's /vault. Checked
# before anything is sent: every collection must live inside the vault being sent.
[ -f "$QMD_CONFIG" ] || die "no QMD config at $QMD_CONFIG"
server_config_dir="$(mktemp -d)"
trap 'rm -rf "$server_config_dir"' EXIT
outside="$(awk -v prefix="$VAULT/" '/^ +path: / && index($2, prefix) != 1 { print $2 }' "$QMD_CONFIG")"
[ -z "$outside" ] || die "collections outside $VAULT cannot be served: $outside"
# Literal prefix swap (no regex: the vault path may contain . or #).
awk -v prefix="$VAULT/" '
  /^ +path: / && index($2, prefix) == 1 {
    indent = substr($0, 1, index($0, "path:") - 1)
    print indent "path: /vault/" substr($2, length(prefix) + 1)
    next
  }
  { print }
' "$QMD_CONFIG" >"$server_config_dir/index.yml"

RSYNC=(rsync -az --human-readable --itemize-changes --partial)
# The model cache belongs to the API user (uid 10001, cloud-init), not to the SSH user: the
# remote rsync runs as that user (setpriv: the uid has no passwd entry), so the files get its owner
# (macOS rsync has no --chown).
MODELS_OWNER=(--rsync-path="sudo setpriv --reuid=10001 --regid=10001 --clear-groups rsync")
VAULT_FILTERS=(--exclude='/_*/' --exclude='/.*' --exclude='/*.sh' --exclude='.DS_Store')

# Count the deletions with a dry run first and refuse before touching the VM: rsync's own
# --max-delete only stops after deleting that many files.
# A failed dry run (SSH down, rsync missing on the VM) aborts: it must never count as 0.
plan="$("${RSYNC[@]}" --dry-run --delete "${VAULT_FILTERS[@]}" "$VAULT/" "$HOST:$REMOTE_ROOT/vault/")" ||
  die "the dry run to count deletions failed; nothing was sent"
deletions="$(grep -c '^\*deleting' <<<"$plan" || true)"
if [ "$deletions" -gt "$MAX_DELETE" ]; then
  die "would delete $deletions files on the VM (limit $MAX_DELETE); nothing was sent. Check the vault, then pass --max-delete $deletions"
fi

echo "sync-vault: $VAULT ($topics topics, $deletions deletions) -> $HOST:$REMOTE_ROOT/vault"
[ "$DRY_RUN" -eq 1 ] && RSYNC+=(--dry-run)
# Only what the API reads: kb.toml and the topic folders. Underscore folders are kb's work
# areas (_convert, _extract, _models) and are skipped by the API too. --max-delete stays as
# a backstop for files deleted on the Mac between the two runs.
"${RSYNC[@]}" --delete --delete-delay --max-delete="$MAX_DELETE" "${VAULT_FILTERS[@]}" \
  "$VAULT/" "$HOST:$REMOTE_ROOT/vault/"

if [ "$DRY_RUN" -eq 1 ]; then
  echo "sync-vault: dry run; would send a snapshot of $INDEX ($(du -h "$INDEX" | cut -f1)) and this QMD config:"
  sed 's/^/  /' "$server_config_dir/index.yml"
  [ "$WITH_MODELS" -eq 1 ] && "${RSYNC[@]}" "${MODELS_OWNER[@]}" "$MODELS/" "$HOST:$REMOTE_ROOT/qmd/cache/models/"
  exit 0
fi

# .backup is consistent even while qmd has the index open (WAL).
sqlite3 "$INDEX" ".backup '$server_config_dir/index.sqlite'"
"${RSYNC[@]}" "$server_config_dir/index.sqlite" "$server_config_dir/index.yml" \
  "$HOST:$REMOTE_ROOT/qmd/incoming/"
if [ "$WITH_MODELS" -eq 1 ]; then
  "${RSYNC[@]}" "${MODELS_OWNER[@]}" "$MODELS/" "$HOST:$REMOTE_ROOT/qmd/cache/models/"
fi

# Swaps the index in and restarts the API (a few seconds of "degraded" search).
# shellcheck disable=SC2029 # the path is meant to expand here, on the Mac
ssh "$HOST" sudo "$REMOTE_ROOT/deploy/scripts/install-index.sh"
echo "sync-vault: done"
