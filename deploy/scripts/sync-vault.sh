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

RSYNC=(rsync -az --human-readable --itemize-changes --partial)
[ "$DRY_RUN" -eq 1 ] && RSYNC+=(--dry-run)

echo "sync-vault: $VAULT ($topics topics) -> $HOST:$REMOTE_ROOT/vault"
# Only what the API reads: kb.toml and the topic folders. Underscore folders are kb's work
# areas (_convert, _extract, _models) and are skipped by the API too.
"${RSYNC[@]}" --delete --delete-delay --max-delete="$MAX_DELETE" \
  --exclude='/_*/' --exclude='/.*' --exclude='/*.sh' --exclude='.DS_Store' \
  "$VAULT/" "$HOST:$REMOTE_ROOT/vault/"

# QMD's collection config with the Mac paths moved to the container's /vault (every
# collection must live inside the vault being sent).
server_config_dir="$(mktemp -d)"
trap 'rm -rf "$server_config_dir"' EXIT
[ -f "$QMD_CONFIG" ] || die "no QMD config at $QMD_CONFIG"
outside="$(awk '/^ +path: / { print $2 }' "$QMD_CONFIG" | grep -v "^$VAULT/" || true)"
[ -z "$outside" ] || die "collections outside $VAULT cannot be served: $outside"
sed "s#^\( *path: \)$VAULT/#\1/vault/#" "$QMD_CONFIG" >"$server_config_dir/index.yml"

if [ "$DRY_RUN" -eq 1 ]; then
  echo "sync-vault: dry run; would send a snapshot of $INDEX ($(du -h "$INDEX" | cut -f1)) and this QMD config:"
  sed 's/^/  /' "$server_config_dir/index.yml"
  [ "$WITH_MODELS" -eq 1 ] && "${RSYNC[@]}" "$MODELS/" "$HOST:$REMOTE_ROOT/qmd/cache/models/"
  exit 0
fi

# .backup is consistent even while qmd has the index open (WAL).
sqlite3 "$INDEX" ".backup '$server_config_dir/index.sqlite'"
"${RSYNC[@]}" "$server_config_dir/index.sqlite" "$server_config_dir/index.yml" \
  "$HOST:$REMOTE_ROOT/qmd/incoming/"
if [ "$WITH_MODELS" -eq 1 ]; then
  "${RSYNC[@]}" "$MODELS/" "$HOST:$REMOTE_ROOT/qmd/cache/models/"
fi

# Swaps the index in and restarts the API (a few seconds of "degraded" search).
# shellcheck disable=SC2029 # the path is meant to expand here, on the Mac
ssh "$HOST" sudo "$REMOTE_ROOT/deploy/scripts/install-index.sh"
echo "sync-vault: done"
