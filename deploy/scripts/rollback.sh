#!/usr/bin/env bash
# Puts a previous release back (ADR 0010): the images of the last releases stay on the VM,
# so no registry access or rebuild is needed.
#   sudo /srv/kb-chat/deploy/scripts/rollback.sh            # the newest good release before the live one
#   sudo /srv/kb-chat/deploy/scripts/rollback.sh <sha>      # a specific release
#   sudo /srv/kb-chat/deploy/scripts/rollback.sh --list     # releases that went live, newest last
# The release rolled back from is recorded in rolled-back.list and never chosen by default
# again, so a second rollback keeps going back (C -> B -> A), never forward to C. A later
# deploy of that SHA through CI clears the mark.
set -euo pipefail

DEPLOY_DIR="${KB_CHAT_DEPLOY_DIR:-/srv/kb-chat/deploy}"
RELEASES="$DEPLOY_DIR/releases.log"
ROLLED_BACK="$DEPLOY_DIR/rolled-back.list"

# The deploy lock, taken before reading any state: a CI deploy cannot change the live
# release between choosing the target and switching to it. The fd and KB_CHAT_LOCKED carry
# over the exec to deploy.sh, which then does not lock again.
if [ "${1:-}" != "--list" ] && [ -z "${KB_CHAT_LOCKED:-}" ]; then
  if command -v flock >/dev/null; then
    exec 9>"$DEPLOY_DIR/.lock"
    flock -w 300 9 || { echo "rollback: another deploy holds $DEPLOY_DIR/.lock" >&2; exit 1; }
    export KB_CHAT_LOCKED=1
  else
    echo "rollback: flock not found; running without the deploy lock" >&2
  fi
fi

current="$("$DEPLOY_DIR/scripts/deploy.sh" --running)"
case "$current" in
  "" | mixed:*) current="$(sed -n 's/^KB_CHAT_TAG=//p' "$DEPLOY_DIR/release.env" 2>/dev/null || true)" ;;
esac

if [ "${1:-}" = "--list" ]; then
  if [ -f "$RELEASES" ]; then cat "$RELEASES"; fi
  echo "running: ${current:-none}"
  if [ -s "$ROLLED_BACK" ]; then echo "rolled back from: $(paste -sd' ' "$ROLLED_BACK")"; fi
  exit 0
fi

target="${1:-}"
if [ -z "$target" ]; then
  bad="${current:-none}"
  if [ -f "$ROLLED_BACK" ]; then bad="$bad"$'\n'"$(cat "$ROLLED_BACK")"; fi
  # The newest live release that is neither the current one nor one rolled back from.
  target="$(awk '{ print $2 }' "$RELEASES" 2>/dev/null | grep -vxF -f <(printf '%s\n' "$bad") | tail -n 1 || true)"
fi
[ -n "$target" ] || { echo "rollback: no earlier good release in $RELEASES" >&2; exit 1; }
[[ "$target" =~ ^[0-9a-f]{7,40}$ ]] || { echo "rollback: '$target' is not a git sha" >&2; exit 2; }

# The list is read into a variable first: `grep -q` on a pipe can stop the producer early,
# and pipefail would turn that SIGPIPE into a false "missing image".
images="$(docker image ls --format '{{.Repository}}:{{.Tag}}')"
for repo in kb-chat-api kb-chat-web; do
  if ! grep -Eq "(^|/)$repo:$target\$" <<<"$images"; then
    echo "rollback: image $repo:$target is not on this VM; deploy it from CI instead" >&2
    exit 1
  fi
done

echo "rollback: ${current:-none} -> $target"
if [ -n "$current" ] && [ "$current" != "$target" ]; then
  grep -qxF "$current" "$ROLLED_BACK" 2>/dev/null || echo "$current" >>"$ROLLED_BACK"
fi
# --no-rollback: if the target also fails its smoke, stop and leave it for a person.
exec "$DEPLOY_DIR/scripts/deploy.sh" "$target" --no-rollback
