#!/usr/bin/env bash
# Sandbox proof (KBC-027 AC-1, ADR 0020). Plants canary copies of what a Codex turn must never
# read (state, the Claude login, the deploy .env, KB_CHAT_SECRETS_KEY) where production keeps
# them, starts the `codex` service from deploy/compose.yml with the probe in place of Codex,
# sends one turn through the runner and fails if the probe saw any canary or server variable.
#   deploy/scripts/codex-sandbox-proof.sh <image tag> [registry]    (CI: an image built locally)
set -euo pipefail

tag="${1:?image tag}"
registry="${2:-docker.io/library}"
repo="$(cd "$(dirname "$0")/../.." && pwd)"
work="$(mktemp -d)"
data="$work/data"
project="kbchat-codex-proof"
mark="KBCHAT-CANARY"

cleanup() {
  docker compose -p "$project" --project-directory "$repo/deploy" --env-file "$work/.env" \
    -f "$repo/deploy/compose.yml" -f "$repo/deploy/compose.codex-proof.yml" down -v >/dev/null 2>&1 || true
  sudo rm -rf "$work" 2>/dev/null || rm -rf "$work"
}
trap cleanup EXIT

mkdir -p "$data/state/settings" "$data/claude" "$data/codex" "$data/vault"
echo "{\"secret\":\"$mark-state\"}" > "$data/state/settings/owner.json"
echo "{\"claudeAiOauth\":\"$mark-claude\"}" > "$data/claude/.credentials.json"
cat > "$work/.env" <<ENV
KB_CHAT_TAG=$tag
KB_CHAT_REGISTRY=$registry
KB_CHAT_DATA=$data
KB_CHAT_DOMAIN=proof.example
GOOGLE_CLIENT_ID=$mark-google
KB_CHAT_OWNER_EMAIL=owner@example.com
KB_CHAT_SECRETS_KEY=$mark-secrets-key
SMTP_USER=proof@example.com
SMTP_PASSWORD=$mark-smtp
COMPOSE_PROFILES=codex
ENV
# Production ownership (cloud-init): the state and the Claude login are the API's (10001).
sudo chown -R 10001:10001 "$data/state" "$data/claude"
sudo chmod 0700 "$data/state" "$data/claude"
sudo chown -R 10002:10002 "$data/codex"

compose() {
  docker compose -p "$project" --project-directory "$repo/deploy" --env-file "$work/.env" \
    -f "$repo/deploy/compose.yml" -f "$repo/deploy/compose.codex-proof.yml" "$@"
}
compose up -d --wait --wait-timeout 120 codex

turn='{"args":["exec","--json","-"],"input":"prove","token":"0123456789abcdef0123456789abcdef"}'
answer="$(compose exec -T codex node -e "
fetch('http://127.0.0.1:8790/turn', { method: 'POST', headers: { 'content-type': 'application/json' }, body: process.argv[1] })
  .then((r) => r.text()).then((t) => process.stdout.write(t))" "$turn")"
echo "$answer"
probe="$(grep '"kbchat.probe"' <<<"$answer")"
node -e "
const probe = JSON.parse(process.argv[1]);
const leaks = [
  ...probe.canaryFiles.map((f) => 'file ' + f),
  ...probe.canaryProcesses.map((p) => 'process ' + p),
  ...probe.canaryEnv.map((e) => 'env ' + e),
  ...probe.serverVariables.map((v) => 'variable ' + v),
  ...probe.serverPathsVisible.map((p) => 'path ' + p),
];
if (probe.uid !== 10002) leaks.push('uid ' + probe.uid);
if (leaks.length > 0) { console.error('SANDBOX LEAK: ' + leaks.join(', ')); process.exit(1); }
console.log('sandbox proof: ok (uid 10002, no canary file, process or variable; env: ' + probe.envNames.join(' ') + ')');
" "$probe"
