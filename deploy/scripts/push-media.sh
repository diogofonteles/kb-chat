#!/usr/bin/env bash
# Moves the Mac's media library to production (KBC-116, ADR 0038), run on the owner's Mac
# after the vault sync (runbook §7, §9f):
#   deploy/scripts/push-media.sh --host ubuntu@<IP> --dry-run   # package, send, import on a copy
#   deploy/scripts/push-media.sh --host ubuntu@<IP>             # the real import (API stopped ~1 min)
# 1. Builds the package from ~/.kb-chat-media and ~/.kb-chat (read only: a snapshot of
#    media.db, the files its rows name, people's e-mails, the authors, sha256 of everything);
#    voice prints and the revocation list are never read (ADR 0032).
# 2. rsyncs it to /srv/kb-chat/media-inbox/package (only what changed since the last time).
# 3. Runs import-media.sh on the VM, which checks every sha256 before touching anything.
set -euo pipefail

HOST=""
DRY=""
OUT="${KB_CHAT_MEDIA_PACKAGE:-$HOME/.cache/kb-chat/media-package}"
INBOX=/srv/kb-chat/media-inbox
REPO="$(cd "$(dirname "$0")/../.." && pwd)"

usage() { echo "usage: push-media.sh --host <user@vm> [--dry-run]" >&2; exit 2; }

while [ $# -gt 0 ]; do
  case "$1" in
    --host) HOST="${2:-}"; shift 2 ;;
    --dry-run) DRY="--dry-run"; shift ;;
    *) usage ;;
  esac
done
[ -n "$HOST" ] || usage

echo "push-media: building the package in $OUT"
(cd "$REPO/apps/api" && pnpm exec tsx --env-file-if-exists=../../.env src/media-transfer-main.ts export --out "$OUT")

# The inbox: the SSH user writes it, the app's group (10001, the import container) reads it,
# nobody else (the package holds people's progress and e-mails). The setgid folder gives every
# file the app's group; import-media.sh seals it again as root before importing.
# shellcheck disable=SC2029 # $INBOX and $DRY are meant to expand here
ssh "$HOST" "sudo install -d -o \"\$(id -un)\" -g 10001 -m 2750 $INBOX"
rsync -a --no-group --delete --checksum --chmod=D2750,F0640 "$OUT/" "$HOST:$INBOX/package/"

echo "push-media: importing on $HOST ${DRY:-(real run)}"
# shellcheck disable=SC2029
ssh "$HOST" "sudo /srv/kb-chat/deploy/scripts/import-media.sh $INBOX/package $DRY"
