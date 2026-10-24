#!/usr/bin/env bash
# Deploys one release (an image tag = the git SHA built by .github/workflows/deploy.yml) on
# the VM, then smokes it; a failed smoke puts the previous release back (ADR 0010).
#   sudo /srv/kb-chat/deploy/scripts/deploy.sh <sha>            # registry login from stdin, optional
#   echo "$TOKEN" | sudo .../deploy.sh <sha> --login <user>      # what CI sends (short-lived token)
# Runs as root: it reads the root-owned .env and talks to the Docker daemon.
set -euo pipefail

DEPLOY_DIR="${KB_CHAT_DEPLOY_DIR:-/srv/kb-chat/deploy}"
RELEASES="$DEPLOY_DIR/releases.log"
REGISTRY_HOST="ghcr.io"
KEEP_IMAGES=5

usage() {
  echo "usage: deploy.sh <git-sha> [--login <registry-user>] [--no-rollback]" >&2
  exit 2
}

log() { printf '%s deploy: %s\n' "$(date -u +%FT%TZ)" "$*"; }

compose() {
  docker compose --project-directory "$DEPLOY_DIR" -f "$DEPLOY_DIR/compose.yml" \
    --env-file "$DEPLOY_DIR/.env" --env-file "$DEPLOY_DIR/release.env" "$@"
}

current_tag() {
  sed -n 's/^KB_CHAT_TAG=//p' "$DEPLOY_DIR/release.env" 2>/dev/null || true
}

write_release() {
  local tag="$1" tmp
  tmp="$(mktemp "$DEPLOY_DIR/.release.XXXXXX")"
  printf 'KB_CHAT_TAG=%s\n' "$tag" >"$tmp"
  chmod 0644 "$tmp"
  mv "$tmp" "$DEPLOY_DIR/release.env"
}

registry_login() {
  local user="$1" token
  token="$(cat)"
  [ -n "$token" ] || { log "no registry token on stdin"; exit 2; }
  printf '%s' "$token" | docker login "$REGISTRY_HOST" -u "$user" --password-stdin >/dev/null
}

# compose.yml and these scripts travel inside the API image (/app/deploy), so each release
# runs with the deploy files of its own commit and a rollback restores them too.
install_deploy_files() {
  local tag="$1" registry cid
  registry="$(sed -n 's/^KB_CHAT_REGISTRY=//p' "$DEPLOY_DIR/.env" | tail -n 1)"
  cid="$(docker create "${registry:-ghcr.io/diogofonteles}/kb-chat-api:$tag")"
  docker cp "$cid:/app/deploy/compose.yml" "$DEPLOY_DIR/compose.yml"
  docker cp "$cid:/app/deploy/scripts/." "$DEPLOY_DIR/scripts/"
  docker rm "$cid" >/dev/null
  if [ "$(id -u)" -eq 0 ]; then chown -R root:root "$DEPLOY_DIR/compose.yml" "$DEPLOY_DIR/scripts"; fi
  chmod 0755 "$DEPLOY_DIR"/scripts/*.sh
}

# Keeps the last KEEP_IMAGES tags of each image, so a rollback never needs the registry.
prune_images() {
  local repo
  for repo in kb-chat-api kb-chat-web; do
    docker image ls --format '{{.Repository}}:{{.Tag}} {{.CreatedAt}}' |
      awk -v r="(^|/)$repo:" '$1 ~ r { print $1 }' |
      tail -n +$((KEEP_IMAGES + 1)) |
      xargs -r docker image rm >/dev/null 2>&1 || true
  done
}

main() {
  local sha="${1:-}" login_user="" rollback=1
  [[ "$sha" =~ ^[0-9a-f]{7,40}$ ]] || usage
  shift
  while [ $# -gt 0 ]; do
    case "$1" in
      --login) login_user="${2:-}"; [ -n "$login_user" ] || usage; shift 2 ;;
      --no-rollback) rollback=0; shift ;;
      *) usage ;;
    esac
  done
  [ -f "$DEPLOY_DIR/.env" ] || { log "missing $DEPLOY_DIR/.env (see deploy/.env.example)"; exit 1; }
  # The API does not start without sign-in (KBC-010): refuse before touching the release.
  local name
  for name in KB_CHAT_DOMAIN GOOGLE_CLIENT_ID KB_CHAT_OWNER_EMAIL; do
    grep -Eq "^$name=.+" "$DEPLOY_DIR/.env" || { log "$name is empty in $DEPLOY_DIR/.env"; exit 1; }
  done

  local previous
  previous="$(current_tag)"
  log "release $sha (previous: ${previous:-none})"

  if [ -n "$login_user" ]; then
    registry_login "$login_user"
    trap 'docker logout "$REGISTRY_HOST" >/dev/null 2>&1 || true' EXIT
  fi

  write_release "$sha"
  # Only what is not on the VM yet: a rollback to a kept image needs no registry.
  if ! compose pull --quiet --policy missing; then
    log "pull failed for $sha; keeping ${previous:-nothing}"
    [ -n "$previous" ] && write_release "$previous"
    exit 1
  fi
  install_deploy_files "$sha"
  compose up -d --remove-orphans --wait --wait-timeout 180 || true

  if "$DEPLOY_DIR/scripts/smoke.sh"; then
    printf '%s %s\n' "$(date -u +%FT%TZ)" "$sha" >>"$RELEASES"
    prune_images
    log "release $sha is live"
    return 0
  fi

  log "smoke failed for $sha"
  if [ "$rollback" -eq 1 ] && [ -n "$previous" ] && [ "$previous" != "$sha" ]; then
    log "rolling back to $previous"
    write_release "$previous"
    install_deploy_files "$previous"
    compose up -d --remove-orphans --wait --wait-timeout 180 || true
    if "$DEPLOY_DIR/scripts/smoke.sh"; then
      log "rolled back to $previous"
    else
      log "rollback smoke failed too"
    fi
  fi
  exit 1
}

main "$@"
