#!/usr/bin/env bash
# Forced command of the CI deploy key (ADR 0010): the key in the GitHub "production"
# environment can only ask for these, never open a shell. In ~deploy/.ssh/authorized_keys:
#   restrict,command="/srv/kb-chat/deploy/scripts/ci-gate.sh" ssh-ed25519 AAAA... kb-chat-ci
# Accepted (SSH_ORIGINAL_COMMAND):
#   deploy <sha> <registry-user> <api-digest> <web-digest>
#                                  registry token on stdin (the workflow's GITHUB_TOKEN); the
#                                  images are pulled by the digests the build job produced
#   smoke                          the VM-side smoke of the current release
#   release                        prints the image tag the containers actually run
#   status                         running tag and backup health
# The deploy runs detached from this SSH session and writes deploy.log; this script streams
# that log back. If the session drops (CI cancelled or timed out), the deploy still finishes
# or rolls back on its own.
set -euo pipefail

DEPLOY_DIR="${KB_CHAT_DEPLOY_DIR:-/srv/kb-chat/deploy}"
read -r -a words <<<"${SSH_ORIGINAL_COMMAND:-}"

case "${words[0]:-}" in
  deploy)
    sha="${words[1]:-}"
    user="${words[2]:-}"
    api_digest="${words[3]:-}"
    web_digest="${words[4]:-}"
    [[ "$sha" =~ ^[0-9a-f]{40}$ ]] || { echo "ci-gate: deploy needs a full git sha" >&2; exit 2; }
    [[ "$user" =~ ^[A-Za-z0-9-]{1,39}$ ]] || { echo "ci-gate: deploy needs the registry user" >&2; exit 2; }
    [[ "$api_digest" =~ ^sha256:[0-9a-f]{64}$ && "$web_digest" =~ ^sha256:[0-9a-f]{64}$ ]] ||
      { echo "ci-gate: deploy needs the two image digests" >&2; exit 2; }
    [ "${#words[@]}" -eq 5 ] || { echo "ci-gate: unexpected arguments" >&2; exit 2; }
    token="$(cat)"
    log_file="$DEPLOY_DIR/deploy.log"
    offset="$(stat -c %s "$log_file" 2>/dev/null || echo 0)"
    # Its own session (setsid): no SIGHUP when this SSH session drops. Background jobs get
    # /dev/null as stdin, so the token goes in as a here-string.
    setsid sudo -n "$DEPLOY_DIR/scripts/deploy.sh" "$sha" --login "$user" \
      --digests "$api_digest" "$web_digest" --log <<<"$token" &
    pid=$!
    unset token
    tail -c +"$((offset + 1))" -F --pid="$pid" "$log_file" 2>/dev/null || true
    wait "$pid"
    ;;
  smoke)
    [ "${#words[@]}" -eq 1 ] || exit 2
    exec sudo -n "$DEPLOY_DIR/scripts/smoke.sh"
    ;;
  status)
    [ "${#words[@]}" -eq 1 ] || exit 2
    exec sudo -n "$DEPLOY_DIR/scripts/deploy.sh" --status
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
