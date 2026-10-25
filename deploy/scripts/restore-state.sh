#!/usr/bin/env bash
# Restores a state backup made by backup-state.sh (ADR 0010). The archive is decrypted on
# the owner's Mac (the age private key never is on the VM) and streamed here:
#   oci os object get --namespace <ns> --bucket-name kb-chat-backups \
#     --name state/kb-chat-state-<stamp>.tar.zst.age --file backup.age
#   age --decrypt --identity ~/.config/kb-chat/backup-age.key backup.age |
#     ssh ubuntu@<vm> sudo /srv/kb-chat/deploy/scripts/restore-state.sh -
# The current state is moved aside (state.before-restore-<stamp>), never deleted.
set -euo pipefail

ROOT="${KB_CHAT_ROOT:-/srv/kb-chat}"
DEPLOY_DIR="$ROOT/deploy"
APP_UID=10001

[ "${1:-}" = "-" ] || { echo "usage: ... | restore-state.sh -   (decrypted .tar.zst on stdin)" >&2; exit 2; }

stamp="$(date -u +%Y%m%dT%H%M%SZ)"
work="$(mktemp -d "$ROOT/.restore.XXXXXX")"
trap 'rm -rf "$work"' EXIT
cat >"$work/state.tar.zst"
tar --zstd -tf "$work/state.tar.zst" >"$work/list"
# Only the paths a backup contains; anything else means a wrong or tampered archive.
if grep -vqE '^(state|claude)(/|$)|^deploy/(\.env|release\.env|releases\.log)$' "$work/list"; then
  echo "restore: unexpected paths in the archive" >&2
  exit 1
fi
# Regular files and folders only: a link could point the restore outside $ROOT.
# The listing goes to a file first: `grep -q` on a pipe could stop tar early and, with
# pipefail, hide the very link it found.
tar --zstd -tvf "$work/state.tar.zst" >"$work/vlist"
if grep -qvE '^[-d]' "$work/vlist"; then
  echo "restore: the archive holds links or special files" >&2
  exit 1
fi

compose() {
  docker compose --project-directory "$DEPLOY_DIR" -f "$DEPLOY_DIR/compose.yml" \
    --env-file "$DEPLOY_DIR/.env" --env-file "$DEPLOY_DIR/release.env" "$@"
}

if [ -z "${KB_CHAT_LOCKED:-}" ] && command -v flock >/dev/null; then
  exec 9>"$DEPLOY_DIR/.lock"
  flock -w 300 9 || { echo "restore: another deploy holds the lock" >&2; exit 1; }
  export KB_CHAT_LOCKED=1
fi

# Extract next to the live state first; the swap only starts once that worked.
mkdir "$work/root"
tar -C "$work/root" --zstd --no-same-owner -xf "$work/state.tar.zst"
compose stop api || true
for dir in state claude; do
  if [ -e "$work/root/$dir" ]; then
    if [ -e "$ROOT/$dir" ]; then mv "$ROOT/$dir" "$ROOT/$dir.before-restore-$stamp"; fi
    mv "$work/root/$dir" "$ROOT/$dir"
  fi
done
for file in .env release.env releases.log; do
  if [ -f "$work/root/deploy/$file" ]; then
    if [ -f "$DEPLOY_DIR/$file" ]; then cp -p "$DEPLOY_DIR/$file" "$DEPLOY_DIR/$file.before-restore-$stamp"; fi
    mv -f "$work/root/deploy/$file" "$DEPLOY_DIR/$file"
  fi
done
chown -R "$APP_UID:$APP_UID" "$ROOT/state" "$ROOT/claude" 2>/dev/null || true
if [ -f "$DEPLOY_DIR/.env" ]; then chown root:root "$DEPLOY_DIR/.env" && chmod 0600 "$DEPLOY_DIR/.env"; fi
compose up -d --wait --wait-timeout 180
"$DEPLOY_DIR/scripts/smoke.sh"
echo "restore: done (previous state kept as *.before-restore-$stamp)"
