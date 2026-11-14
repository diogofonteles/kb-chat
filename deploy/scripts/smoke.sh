#!/usr/bin/env bash
# Smoke checks of a running kb-chat (ADR 0010, KBC-012). Used by deploy.sh on the VM, by the
# deploy workflow from the internet, and locally against `docker compose` on the Mac.
#   smoke.sh                                  # https://$KB_CHAT_DOMAIN (read from .env on the VM)
#   smoke.sh https://kb.example.com
#   SMOKE_INSECURE=1 smoke.sh https://localhost:8443          # Caddy's local CA
#   SMOKE_RESOLVE=kb.example.com:443:127.0.0.1 smoke.sh       # from the VM itself
# Checks: /health answers with a status; the SPA shell loads with the security headers;
# /mcp is not served publicly; without a session the API refuses (401) once sign-in is on;
# the public privacy policy (/privacidade, KBC-016) and tutorial (/tutorial, KBC-032) are
# served without a session.
#   SMOKE_URL=...    base URL when no argument is given
#   SMOKE_AUTH=off   skips the 401 check (a build without KBC-010)
#   SMOKE_STRICT=1   also fails when /health reports "degraded" (qmd down, kb fallback)
set -euo pipefail

DEPLOY_DIR="${KB_CHAT_DEPLOY_DIR:-/srv/kb-chat/deploy}"
ATTEMPTS="${SMOKE_ATTEMPTS:-12}"
DELAY="${SMOKE_DELAY:-5}"

domain_from_env() {
  sed -n 's/^KB_CHAT_DOMAIN=//p' "$DEPLOY_DIR/.env" 2>/dev/null | tail -n 1
}

BASE="${1:-${SMOKE_URL:-}}"
if [ -z "$BASE" ]; then
  domain="${KB_CHAT_DOMAIN:-$(domain_from_env)}"
  [ -n "$domain" ] || { echo "smoke: no URL and no KB_CHAT_DOMAIN" >&2; exit 2; }
  BASE="https://$domain"
  # On the VM, reach Caddy directly instead of going out and back through the public IP.
  if [ -z "${SMOKE_RESOLVE:-}" ] && [ -f "$DEPLOY_DIR/.env" ]; then
    SMOKE_RESOLVE="$domain:443:127.0.0.1"
  fi
fi
BASE="${BASE%/}"

CURL=(curl -sS --max-time 15 --proto '=https,http')
[ "${SMOKE_INSECURE:-0}" = "1" ] && CURL+=(-k)
[ -n "${SMOKE_RESOLVE:-}" ] && CURL+=(--resolve "$SMOKE_RESOLVE")

failures=0
pass() { echo "smoke ok:   $*"; }
fail() { echo "smoke FAIL: $*" >&2; failures=$((failures + 1)); }

# Waits for /health first: a fresh container needs a few seconds (catalog, qmd warm-up).
wait_health() {
  local attempt body
  for attempt in $(seq 1 "$ATTEMPTS"); do
    if body="$("${CURL[@]}" -f "$BASE/health" 2>/dev/null)"; then
      echo "$body"
      return 0
    fi
    echo "smoke: /health not ready (attempt $attempt/$ATTEMPTS)" >&2
    sleep "$DELAY"
  done
  return 1
}

check_health() {
  local body
  if ! body="$(wait_health)"; then
    fail "/health never answered 200"
    return
  fi
  case "$body" in
    *'"status":"ok"'*) pass "/health status ok" ;;
    *'"status":"degraded"'*)
      if [ "${SMOKE_STRICT:-0}" = "1" ]; then fail "/health degraded (strict)"; else pass "/health degraded (search through kb fallback)"; fi ;;
    *) fail "/health without a status: $body" ;;
  esac
}

check_shell() {
  local headers body
  headers="$(mktemp)"
  body="$("${CURL[@]}" -f -D "$headers" "$BASE/" 2>/dev/null)" || { fail "/ did not answer 200"; rm -f "$headers"; return; }
  if grep -q '<app-root' <<<"$body"; then pass "/ serves the SPA shell"; else fail "/ is not the SPA shell"; fi
  local header
  for header in content-security-policy strict-transport-security x-content-type-options; do
    if grep -qi "^$header:" "$headers"; then pass "header $header"; else fail "missing header $header"; fi
  done
  rm -f "$headers"
}

status_of() {
  "${CURL[@]}" -o /dev/null -w '%{http_code}' "$@" 2>/dev/null || echo 000
}

# A public page of the SPA (KBC-016 /privacidade, KBC-032 /tutorial): served without a
# session, never cached (a deploy changes it), with the CSP.
check_public_page() {
  local path="$1" headers body
  headers="$(mktemp)"
  body="$("${CURL[@]}" -f -D "$headers" "$BASE$path" 2>/dev/null)" || { fail "$path did not answer 200"; rm -f "$headers"; return; }
  if grep -q '<app-root' <<<"$body"; then pass "$path serves the SPA shell without a session"; else fail "$path is not the SPA shell"; fi
  if grep -qi '^cache-control:.*no-cache' "$headers"; then pass "$path is not cached"; else fail "$path without Cache-Control: no-cache"; fi
  if grep -qi '^content-security-policy:' "$headers"; then pass "$path has a Content-Security-Policy"; else fail "$path without Content-Security-Policy"; fi
  rm -f "$headers"
}

check_mcp_hidden() {
  local code
  # The real route shape (/mcp/turns/:token), with a token that cannot exist.
  code="$(status_of -X POST "$BASE/mcp/turns/smoke-check-not-a-real-turn-token")"
  if [ "$code" = "404" ]; then pass "/mcp is not public (404)"; else fail "/mcp answered $code from outside"; fi
}

check_auth() {
  [ "${SMOKE_AUTH:-on}" = "off" ] && { echo "smoke skip: sign-in check (SMOKE_AUTH=off)"; return; }
  local code
  code="$(status_of "$BASE/api/v1/topics")"
  if [ "$code" = "401" ]; then pass "/api/v1/topics refuses without a session (401)"; else fail "/api/v1/topics answered $code without a session (want 401)"; fi
}

check_health
check_shell
check_public_page /privacidade
check_public_page /tutorial
# Every other route falls back to the shell and is never cached either (KBC-122).
check_public_page /login
check_public_page /conversas/smoke-check-route
check_mcp_hidden
check_auth

if [ "$failures" -gt 0 ]; then
  echo "smoke: $failures check(s) failed against $BASE" >&2
  exit 1
fi
echo "smoke: all checks passed against $BASE"
