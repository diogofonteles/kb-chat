#!/usr/bin/env bash
# One-time bootstrap of the deploy files on a fresh VM (ADR 0010), run from the owner's Mac
# after cloud-init finished. Later releases bring their own compose.yml and scripts inside
# the API image (deploy.sh installs them), so this is needed once, or after a rebuild.
#   deploy/oci/bootstrap-vm.sh ubuntu@<vm-ip>
# It never sends secrets: the .env on the VM is created from deploy/.env.example and the
# owner fills it in over SSH (docs/deploy/runbook.md).
set -euo pipefail

HOST="${1:-}"
[ -n "$HOST" ] || { echo "usage: bootstrap-vm.sh ubuntu@<vm-ip>" >&2; exit 2; }
HERE="$(cd "$(dirname "$0")/.." && pwd)"

ssh "$HOST" 'test -f /var/lib/kb-chat-cloud-init-done' ||
  { echo "bootstrap: cloud-init has not finished on $HOST (see /var/log/cloud-init-output.log)" >&2; exit 1; }

staging="$(ssh "$HOST" mktemp -d)"
rsync -a "$HERE/compose.yml" "$HERE/.env.example" "$HERE/scripts" "$HOST:$staging/"
# shellcheck disable=SC2029 # $staging is meant to expand here, on the Mac
ssh "$HOST" sudo bash -s -- "$staging" <<'EOF'
set -euo pipefail
staging="$1"
install -d -m 0755 -o root -g root /srv/kb-chat/deploy /srv/kb-chat/deploy/scripts
install -m 0644 -o root -g root "$staging/compose.yml" /srv/kb-chat/deploy/compose.yml
install -m 0755 -o root -g root "$staging"/scripts/*.sh /srv/kb-chat/deploy/scripts/
if [ ! -f /srv/kb-chat/deploy/.env ]; then
  install -m 0600 -o root -g root "$staging/.env.example" /srv/kb-chat/deploy/.env
  echo "bootstrap: created /srv/kb-chat/deploy/.env from the example; edit it with sudo"
fi
rm -rf "$staging"
docker compose version
echo "bootstrap: deploy files installed"
EOF
