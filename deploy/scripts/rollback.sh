#!/usr/bin/env bash
# Puts a previous release back (ADR 0010): the images of the last releases stay on the VM,
# so no registry access or rebuild is needed.
#   sudo /srv/kb-chat/deploy/scripts/rollback.sh            # the release before the current one
#   sudo /srv/kb-chat/deploy/scripts/rollback.sh <sha>      # a specific release
#   sudo /srv/kb-chat/deploy/scripts/rollback.sh --list     # releases that went live, newest last
set -euo pipefail

DEPLOY_DIR="${KB_CHAT_DEPLOY_DIR:-/srv/kb-chat/deploy}"
RELEASES="$DEPLOY_DIR/releases.log"

current="$(sed -n 's/^KB_CHAT_TAG=//p' "$DEPLOY_DIR/release.env" 2>/dev/null || true)"

if [ "${1:-}" = "--list" ]; then
  [ -f "$RELEASES" ] && cat "$RELEASES"
  echo "current: ${current:-none}"
  exit 0
fi

target="${1:-}"
if [ -z "$target" ]; then
  # The newest live release that is not the current one.
  target="$(awk '{ print $2 }' "$RELEASES" 2>/dev/null | grep -vx "${current:-none}" | tail -n 1 || true)"
fi
[ -n "$target" ] || { echo "rollback: no previous release in $RELEASES" >&2; exit 1; }

for repo in kb-chat-api kb-chat-web; do
  if ! docker image ls --format '{{.Repository}}:{{.Tag}}' | grep -Eq "(^|/)$repo:$target\$"; then
    echo "rollback: image $repo:$target is not on this VM; deploy it from CI instead" >&2
    exit 1
  fi
done

echo "rollback: $current -> $target"
# --no-rollback: if the target also fails its smoke, stop and leave it for a person.
exec "$DEPLOY_DIR/scripts/deploy.sh" "$target" --no-rollback
