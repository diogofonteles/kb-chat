#!/usr/bin/env bash
# Sandbox check on the VM (KBC-027, ADR 0020), as root: plants a fresh canary in the state
# and in the Claude login folder, runs the probe in the live `codex` container with a bare
# environment (as the runner runs Codex), and fails if it saw the canary, a server variable,
# an extra mount, a capability or the metadata service. The canaries are removed at the end.
#   sudo /srv/kb-chat/deploy/scripts/codex-vm-check.sh
set -euo pipefail
ROOT="${KB_CHAT_DATA:-/srv/kb-chat}"
DEPLOY_DIR="$ROOT/deploy"
mark="KBCHAT-CANARY-$(od -An -N12 -tx1 /dev/urandom | tr -d ' \n')"
canaries=("$ROOT/state/.sandbox-canary" "$ROOT/claude/.sandbox-canary")
cleanup() { rm -f "${canaries[@]}"; }
trap cleanup EXIT
for file in "${canaries[@]}"; do
  echo "$mark" >"$file"
  chown 10001:10001 "$file"
  chmod 0600 "$file"
done
answer="$(printf '%s' "$mark" | docker compose --project-directory "$DEPLOY_DIR" \
  -f "$DEPLOY_DIR/compose.yml" --env-file "$DEPLOY_DIR/.env" --env-file "$DEPLOY_DIR/release.env" \
  exec -T codex env -i PATH=/usr/local/bin:/usr/bin:/bin /app/deploy/codex-proof/probe.mjs)"
echo "$answer"
# The runner's own environment (pid 1's, readable as the same user) holds no server secret.
if docker compose --project-directory "$DEPLOY_DIR" -f "$DEPLOY_DIR/compose.yml" \
  --env-file "$DEPLOY_DIR/.env" --env-file "$DEPLOY_DIR/release.env" \
  exec -T codex cat /proc/1/environ | tr '\0' '\n' |
  grep -qE '^(KB_CHAT_SECRETS_KEY|SMTP_PASSWORD|RESEND_API_KEY|GOOGLE_CLIENT_ID)='; then
  echo "SANDBOX LEAK: a server secret is in the runner's environment" >&2
  exit 1
fi
node_check='
const probe = JSON.parse(process.argv[1]);
const leaks = [
  ...probe.canaryFiles, ...probe.canaryProcesses, ...probe.canaryEnv,
  ...probe.serverVariables, ...probe.serverPathsVisible, ...probe.extraMounts,
];
if (!probe.rootReadOnly) leaks.push("writable root");
if (!probe.noCapabilities) leaks.push("capabilities");
if (!probe.noNewPrivileges) leaks.push("new privileges");
if (probe.metadataReachable) leaks.push("metadata service");
if (probe.uid !== 10002) leaks.push("uid " + probe.uid);
if (leaks.length) { console.error("SANDBOX LEAK: " + leaks.join(", ")); process.exit(1); }
console.log("sandbox check: ok");'
docker compose --project-directory "$DEPLOY_DIR" -f "$DEPLOY_DIR/compose.yml" \
  --env-file "$DEPLOY_DIR/.env" --env-file "$DEPLOY_DIR/release.env" \
  exec -T api node -e "$node_check" "$answer"
