#!/usr/bin/env bash
# Deploys one release (an image tag = the git SHA built by .github/workflows/deploy.yml) on
# the VM, then smokes it; any failure (pull, deploy files, compose up, wrong running tag,
# smoke) puts the previous release back (ADR 0010).
#   sudo /srv/kb-chat/deploy/scripts/deploy.sh <sha>                 # images already on the VM
#   echo "$TOKEN" | sudo .../deploy.sh <sha> --login <user>           # what CI sends (short-lived token)
#   ... deploy.sh <sha> --login <user> --digests <api> <web> --log    # CI: pull by digest, log to file
#   sudo .../deploy.sh --running                                      # the tag the containers run
#   sudo .../deploy.sh --status                                       # running tag + backup health
# Runs as root: it reads the root-owned .env and talks to the Docker daemon.
set -euo pipefail

DEPLOY_DIR="${KB_CHAT_DEPLOY_DIR:-/srv/kb-chat/deploy}"
RELEASES="$DEPLOY_DIR/releases.log"
ROLLED_BACK="$DEPLOY_DIR/rolled-back.list"
REGISTRY_HOST="ghcr.io"
PROJECT="kb-chat"
KEEP_IMAGES=5

usage() {
  echo "usage: deploy.sh <git-sha> [--login <user>] [--digests <api-digest> <web-digest>] [--no-rollback] [--log] | --running | --status" >&2
  exit 2
}

# Never fatal: with the CI's SSH session gone, a write to stdout must not stop a deploy.
log() { printf '%s deploy: %s\n' "$(date -u +%FT%TZ)" "$*" || true; }

# One deploy, rollback, index swap or restore at a time (they all rewrite release.env or
# restart the stack). A parent that already holds the lock exports KB_CHAT_LOCKED.
take_lock() {
  [ -n "${KB_CHAT_LOCKED:-}" ] && return 0
  if ! command -v flock >/dev/null; then
    log "flock not found; running without the deploy lock"
    return 0
  fi
  exec 9>"$DEPLOY_DIR/.lock"
  flock -w 300 9 || { log "another deploy holds $DEPLOY_DIR/.lock"; exit 1; }
  export KB_CHAT_LOCKED=1
}

compose() {
  local files=(--env-file "$DEPLOY_DIR/.env")
  # The first deploy has no release.env yet (the tag then comes from the environment).
  if [ -f "$DEPLOY_DIR/release.env" ]; then files+=(--env-file "$DEPLOY_DIR/release.env"); fi
  docker compose --project-directory "$DEPLOY_DIR" -f "$DEPLOY_DIR/compose.yml" "${files[@]}" "$@"
}

env_value() {
  sed -n "s/^$1=//p" "$DEPLOY_DIR/.env" 2>/dev/null | tail -n 1
}

image_ref() {
  local registry
  registry="$(env_value KB_CHAT_REGISTRY)"
  echo "${registry:-ghcr.io/diogofonteles}/$1:$2"
}

release_file_tag() {
  sed -n 's/^KB_CHAT_TAG=//p' "$DEPLOY_DIR/release.env" 2>/dev/null || true
}

# The tag the running containers were created from (not what release.env says): one tag
# when api and web agree, "mixed:<api>/<web>" otherwise, empty when nothing runs.
running_tag() {
  local service image tags=()
  for service in api web; do
    image="$(docker ps --filter "label=com.docker.compose.project=$PROJECT" \
      --filter "label=com.docker.compose.service=$service" --format '{{.Image}}' | head -n 1)"
    tags+=("${image##*:}")
  done
  if [ -z "${tags[0]}" ] && [ -z "${tags[1]}" ]; then
    echo ""
  elif [ "${tags[0]}" = "${tags[1]}" ]; then
    echo "${tags[0]}"
  else
    echo "mixed:${tags[0]:-none}/${tags[1]:-none}"
  fi
}

write_release() {
  local tag="$1" tmp
  tmp="$(mktemp "$DEPLOY_DIR/.release.XXXXXX")"
  printf 'KB_CHAT_TAG=%s\n' "$tag" >"$tmp"
  chmod 0644 "$tmp"
  mv -f "$tmp" "$DEPLOY_DIR/release.env"
}

registry_login() {
  local user="$1" token
  token="$(cat)"
  [ -n "$token" ] || { log "no registry token on stdin"; exit 2; }
  printf '%s' "$token" | docker login "$REGISTRY_HOST" -u "$user" --password-stdin >/dev/null
}

# Sanity check only: both images must say they were built from the requested commit. It
# catches a tag that points at another commit's build. It is no defence against a malicious
# push (whoever builds the image writes the label); against that, CI deploys pull the exact
# digests its own build job produced (pull_by_digest), see ADR 0010.
verify_revision() {
  local tag="$1" repo revision
  for repo in kb-chat-api kb-chat-web; do
    revision="$(docker image inspect -f '{{index .Config.Labels "org.opencontainers.image.revision"}}' \
      "$(image_ref "$repo" "$tag")" 2>/dev/null || true)"
    if [ -z "$revision" ] || [[ "$revision" != "$tag"* ]]; then
      log "$repo:$tag has revision '${revision:-none}', not $tag; refusing it"
      return 1
    fi
  done
}

# Pulls each image by the digest the CI build job reported and tags it <sha> locally, so
# compose runs exactly those bytes even if the :<sha> tag in the registry was overwritten.
pull_by_digest() {
  local tag="$1" api_digest="$2" web_digest="$3" repo digest base
  for repo in kb-chat-api kb-chat-web; do
    digest="$api_digest"
    [ "$repo" = kb-chat-web ] && digest="$web_digest"
    base="$(image_ref "$repo" "$tag")"
    base="${base%:*}"
    docker pull --quiet "$base@$digest" >/dev/null || { log "pull of $base@$digest failed"; return 1; }
    docker tag "$base@$digest" "$base:$tag"
    if ! docker image inspect -f '{{join .RepoDigests " "}}' "$base:$tag" | tr ' ' '\n' | grep -qxF "$base@$digest"; then
      log "$base:$tag is not $digest after the pull"
      return 1
    fi
  done
}

# Backup health for --status (and the deploy workflow's summary): written by
# backup-state.sh on success and by kb-chat-backup-failed.service on failure.
backup_status() {
  local file="$DEPLOY_DIR/backup-status" state when age
  if [ ! -f "$file" ]; then
    echo "never"
    return 0
  fi
  read -r state when <"$file" || true
  if [ "$state" = "ok" ] && age="$(($(date -u +%s) - $(date -u -d "$when" +%s 2>/dev/null || echo 0)))" &&
    [ "$age" -gt $((48 * 3600)) ]; then
    state="stale"
  fi
  echo "$state $when"
}

# compose.yml and these scripts travel inside the API image (/app/deploy), so each release
# runs with the deploy files of its own commit. They are copied to a staging folder and
# swapped in by rename: a running script keeps reading its old (unlinked) file.
install_deploy_files() {
  local tag="$1" staging cid
  staging="$(mktemp -d "$DEPLOY_DIR/.incoming.XXXXXX")"
  cid="$(docker create "$(image_ref kb-chat-api "$tag")")" || { rm -rf "$staging"; return 1; }
  if ! docker cp "$cid:/app/deploy/." "$staging/"; then
    docker rm "$cid" >/dev/null 2>&1 || true
    rm -rf "$staging"
    return 1
  fi
  docker rm "$cid" >/dev/null 2>&1 || true
  if [ ! -f "$staging/compose.yml" ] || [ ! -x "$staging/scripts/deploy.sh" ]; then
    log "the image of $tag has no deploy files"
    rm -rf "$staging"
    return 1
  fi
  if [ "$(id -u)" -eq 0 ]; then chown -R root:root "$staging"; fi
  chmod 0644 "$staging/compose.yml"
  chmod 0755 "$staging"/scripts/*.sh
  mv -f "$staging/compose.yml" "$DEPLOY_DIR/compose.yml"
  rm -rf "$DEPLOY_DIR/scripts.old"
  if [ -d "$DEPLOY_DIR/scripts" ]; then mv "$DEPLOY_DIR/scripts" "$DEPLOY_DIR/scripts.old"; fi
  mv "$staging/scripts" "$DEPLOY_DIR/scripts"
  rm -rf "$DEPLOY_DIR/scripts.old" "$staging"
}

# Makes <tag> the live release. Every step must succeed; the caller rolls back otherwise.
activate() {
  local tag="$1" live
  install_deploy_files "$tag" || return 1
  write_release "$tag" || return 1
  if ! compose up -d --remove-orphans --wait --wait-timeout 180; then
    log "compose up failed for $tag"
    return 1
  fi
  live="$(running_tag)"
  if [ "$live" != "$tag" ]; then
    log "the containers run '${live:-nothing}', not $tag"
    return 1
  fi
  "$DEPLOY_DIR/scripts/smoke.sh" || return 1
}

# Keeps the images of the last KEEP_IMAGES live releases (releases.log), so a rollback never
# needs the registry. Only images of releases that went live and fell out of that window are
# removed; anything else (a failed release kept for debugging) is left alone.
prune_images() {
  local keep old tag repo
  # The last KEEP_IMAGES distinct SHAs, newest first (a rollback counts as recent again).
  keep="$(awk -v k="$KEEP_IMAGES" '{ tag[NR] = $2 }
    END { for (i = NR; i > 0 && c < k; i--) if (!seen[tag[i]]++) { print tag[i]; c++ } }' "$RELEASES" 2>/dev/null || true)"
  old="$(awk '{ print $2 }' "$RELEASES" 2>/dev/null | sort -u | grep -vxF -f <(printf '%s\n' "$keep") || true)"
  for tag in $old; do
    for repo in kb-chat-api kb-chat-web; do
      docker image rm "$(image_ref "$repo" "$tag")" >/dev/null 2>&1 || true
    done
  done
}

commit_release() {
  local tag="$1"
  printf '%s %s\n' "$(date -u +%FT%TZ)" "$tag" >>"$RELEASES"
  # A release that is deployed again on purpose is no longer "rolled back".
  if [ -f "$ROLLED_BACK" ]; then
    grep -vx "$tag" "$ROLLED_BACK" >"$ROLLED_BACK.tmp" || true
    mv -f "$ROLLED_BACK.tmp" "$ROLLED_BACK"
  fi
  prune_images
}

# Safety net for anything that stops the script between changing release.env and the end
# (a signal, an unexpected error): release.env must name what was live before.
PREVIOUS=""
CHANGING=0
LOGGED_IN=0
on_exit() {
  local rc=$? live
  if [ "$CHANGING" -eq 1 ]; then
    # Name what actually runs (a target that failed under --no-rollback may still be up);
    # fall back to the release that was live before.
    live="$(running_tag)"
    case "$live" in "" | mixed:*) live="$PREVIOUS" ;; esac
    if [ -n "$live" ] && [ "$(release_file_tag)" != "$live" ]; then
      log "stopped mid-release; release.env set to $live (what is running)"
      write_release "$live" || true
    fi
  fi
  if [ "$LOGGED_IN" -eq 1 ]; then docker logout "$REGISTRY_HOST" >/dev/null 2>&1 || true; fi
  exit "$rc"
}

env_set() { grep -Eq "^$1=.+" "$DEPLOY_DIR/.env"; }

# Sign-in settings plus one complete email provider: Gmail SMTP (SMTP_USER + SMTP_PASSWORD)
# or Resend (RESEND_API_KEY + KB_CHAT_EMAIL_FROM). Half of the SMTP pair is a typo.
check_env() {
  local name
  for name in KB_CHAT_DOMAIN GOOGLE_CLIENT_ID KB_CHAT_OWNER_EMAIL; do
    env_set "$name" || { log "$name is empty in $DEPLOY_DIR/.env"; return 1; }
  done
  if env_set SMTP_USER && ! env_set SMTP_PASSWORD; then
    log "SMTP_USER is set without SMTP_PASSWORD in $DEPLOY_DIR/.env"; return 1
  fi
  if env_set SMTP_PASSWORD && ! env_set SMTP_USER; then
    log "SMTP_PASSWORD is set without SMTP_USER in $DEPLOY_DIR/.env"; return 1
  fi
  if ! env_set SMTP_USER && ! { env_set RESEND_API_KEY && env_set KB_CHAT_EMAIL_FROM; }; then
    log "no email provider in $DEPLOY_DIR/.env: set SMTP_USER and SMTP_PASSWORD (Gmail), or RESEND_API_KEY and KB_CHAT_EMAIL_FROM"
    return 1
  fi
}

main() {
  if [ "${1:-}" = "--running" ]; then
    running_tag
    return 0
  fi
  if [ "${1:-}" = "--status" ]; then
    echo "running=$(running_tag)"
    echo "backup=$(backup_status)"
    return 0
  fi
  local sha="${1:-}" login_user="" rollback=1 api_digest="" web_digest="" to_log=0
  [[ "$sha" =~ ^[0-9a-f]{7,40}$ ]] || usage
  shift
  while [ $# -gt 0 ]; do
    case "$1" in
      --login) login_user="${2:-}"; [ -n "$login_user" ] || usage; shift 2 ;;
      --no-rollback) rollback=0; shift ;;
      --digests)
        api_digest="${2:-}"
        web_digest="${3:-}"
        [[ "$api_digest" =~ ^sha256:[0-9a-f]{64}$ && "$web_digest" =~ ^sha256:[0-9a-f]{64}$ ]] || usage
        shift 3
        ;;
      --log) to_log=1; shift ;;
      *) usage ;;
    esac
  done
  # A dropped SSH session (CI cancelled or timed out) must not kill a half-done release.
  trap '' HUP PIPE
  if [ "$to_log" -eq 1 ]; then exec >>"$DEPLOY_DIR/deploy.log" 2>&1; fi
  [ -f "$DEPLOY_DIR/.env" ] || { log "missing $DEPLOY_DIR/.env (see deploy/.env.example)"; exit 1; }
  # The API does not start without sign-in (KBC-010) nor, in production, without an email
  # provider for one-time codes (KBC-014, ADR 0011/0012): refuse before touching the release.
  check_env || exit 1
  if grep -Eq "^KB_CHAT_SMS=[\"' ]*log" "$DEPLOY_DIR/.env"; then
    log "KB_CHAT_SMS=log writes codes to the log: not in production"; exit 1
  fi

  take_lock
  trap on_exit EXIT
  trap 'exit 130' INT TERM

  # What actually runs wins over release.env (which only says what was last asked for).
  PREVIOUS="$(running_tag)"
  case "$PREVIOUS" in "" | mixed:*) PREVIOUS="$(release_file_tag)" ;; esac
  log "release $sha (previous: ${PREVIOUS:-none})"

  if [ -n "$login_user" ]; then
    registry_login "$login_user"
    LOGGED_IN=1
  fi
  # release.env is untouched until the images are here. CI passes the digests its build
  # produced; a manual deploy or a rollback uses the images already on the VM (or the tag).
  if [ -n "$api_digest" ]; then
    pull_by_digest "$sha" "$api_digest" "$web_digest" || { log "pull failed for $sha; nothing changed"; exit 1; }
  elif ! KB_CHAT_TAG="$sha" compose pull --quiet --policy missing; then
    log "pull failed for $sha; nothing changed"
    exit 1
  fi
  verify_revision "$sha" || exit 1

  CHANGING=1
  if activate "$sha"; then
    commit_release "$sha"
    CHANGING=0
    log "release $sha is live"
    return 0
  fi

  log "release $sha failed"
  if [ "$rollback" -eq 1 ] && [ -n "$PREVIOUS" ] && [ "$PREVIOUS" != "$sha" ]; then
    log "rolling back to $PREVIOUS"
    if activate "$PREVIOUS"; then
      CHANGING=0
      log "rolled back to $PREVIOUS"
    else
      log "rollback to $PREVIOUS failed too; a person must look (docs/deploy/runbook.md)"
    fi
  fi
  # CHANGING still 1 (no rollback or a failed one): on_exit makes release.env name what runs.
  exit 1
}

main "$@"
