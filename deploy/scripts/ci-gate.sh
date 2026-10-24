#!/usr/bin/env bash
# Forced command of the CI deploy key (ADR 0010): the key in the GitHub "production"
# environment can only ask for these, never open a shell. In ~deploy/.ssh/authorized_keys:
#   restrict,command="/srv/kb-chat/deploy/scripts/ci-gate.sh" ssh-ed25519 AAAA... kb-chat-ci
# Accepted (SSH_ORIGINAL_COMMAND):
#   deploy <sha> <registry-user>   registry token on stdin (the workflow's GITHUB_TOKEN)
#   smoke                          the VM-side smoke of the current release
#   release                        prints the image tag the containers actually run
set -euo pipefail

DEPLOY_DIR="${KB_CHAT_DEPLOY_DIR:-/srv/kb-chat/deploy}"
read -r -a words <<<"${SSH_ORIGINAL_COMMAND:-}"

case "${words[0]:-}" in
  deploy)
    sha="${words[1]:-}"
    user="${words[2]:-}"
    [[ "$sha" =~ ^[0-9a-f]{40}$ ]] || { echo "ci-gate: deploy needs a full git sha" >&2; exit 2; }
    [[ "$user" =~ ^[A-Za-z0-9-]{1,39}$ ]] || { echo "ci-gate: deploy needs the registry user" >&2; exit 2; }
    [ "${#words[@]}" -eq 3 ] || { echo "ci-gate: unexpected arguments" >&2; exit 2; }
    exec sudo -n "$DEPLOY_DIR/scripts/deploy.sh" "$sha" --login "$user"
    ;;
  smoke)
    [ "${#words[@]}" -eq 1 ] || exit 2
    exec sudo -n "$DEPLOY_DIR/scripts/smoke.sh"
    ;;
  release)
    [ "${#words[@]}" -eq 1 ] || exit 2
    exec sudo -n "$DEPLOY_DIR/scripts/deploy.sh" --running
    ;;
  *)
    echo "ci-gate: refused" >&2
    exit 2
    ;;
esac
