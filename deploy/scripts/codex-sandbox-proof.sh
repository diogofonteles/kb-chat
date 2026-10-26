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
# A fresh canary per run: only the copies planted below carry it.
mark="KBCHAT-CANARY-$(od -An -N12 -tx1 /dev/urandom | tr -d ' \n')"

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

turn="{\"input\":\"$mark\",\"token\":\"0123456789abcdef0123456789abcdef\"}"
post_turn='fetch(process.argv[1] + "/turn", { method: "POST", headers: { "content-type": "application/json" }, body: process.argv[2] })
  .then(async (r) => process.stdout.write(r.status === 200 ? await r.text() : "status " + r.status + "\n"))'
# From inside the sandbox (a turn calling its own runner): refused (ADR 0020).
inside="$(compose exec -T codex node -e "$post_turn" http://127.0.0.1:8790 "$turn")"
echo "from inside the sandbox: $inside"
[ "$inside" = "status 403" ] || { echo "SANDBOX LEAK: the runner answered a turn from inside the sandbox" >&2; exit 1; }
# From the API's address on the codex network, as in production. The first turn leaves a
# detached process behind; the runner must have reaped it before the second turn runs.
from_api() {
  docker run --rm --network "${project}_codex" --ip 172.30.0.2 --entrypoint node \
    "$registry/kb-chat-api:$tag" -e "$post_turn" http://172.30.0.10:8790 "$1"
}
stray_turn="{\"input\":\"$mark\\nleave-a-stray\",\"token\":\"0123456789abcdef0123456789abcdef\"}"
from_api "$stray_turn" >/dev/null
answer="$(from_api "$turn")"
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
if (probe.error) leaks.push('probe ' + probe.error);
leaks.push(...probe.extraMounts.map((m) => 'mount ' + m));
if (!probe.rootReadOnly) leaks.push('writable root');
if (!probe.noCapabilities) leaks.push('capabilities');
if (!probe.noNewPrivileges) leaks.push('new privileges allowed');
if (probe.metadataReachable) leaks.push('metadata service reachable');
leaks.push(...probe.strays.map((pid) => 'process left by another turn ' + pid));
if (probe.uid !== 10002) leaks.push('uid ' + probe.uid);
if (leaks.length > 0) { console.error('SANDBOX LEAK: ' + leaks.join(', ')); process.exit(1); }
console.log('sandbox proof: ok (uid 10002, no canary file, process or variable, only its own mounts, read-only root, no capabilities, no new privileges, no metadata service, no process left by another turn; env: ' + probe.envNames.join(' ') + ')');
" "$probe"
