#!/usr/bin/env bash
# Proves that the real deploy/Caddyfile hands the board's live events over as they happen. A stub of
# the hub sends one event at once and another 3 s later; if the edge buffered them, they would
# arrive together and open pages would stop updating by themselves. Run by CI (Docker required).
set -euo pipefail

caddy_image="${CADDY_IMAGE:-caddy:2.10-alpine}"
node_image="${NODE_IMAGE:-node:22-alpine}"
name="board-edge-proof"
root="$(cd "$(dirname "$0")/../.." && pwd -P)"
work="$(mktemp -d)"
cleanup() {
  docker rm -f "$name-caddy" "$name-hub" >/dev/null 2>&1 || true
  docker network rm "$name" >/dev/null 2>&1 || true
  rm -rf "$work"
}
trap cleanup EXIT

# The page's policy comes from the web build; this proof does not need the real one.
printf 'header X-Proof "1"\n' >"$work/csp.caddy"
cat >"$work/hub.js" <<'JS'
require('node:http').createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store' });
  res.write('event: rev\ndata: first\n\n');
  setTimeout(() => res.end('event: rev\ndata: second\n\n'), 3000);
}).listen(4600, '0.0.0.0');
JS

docker network create "$name" >/dev/null
docker run -d --name "$name-hub" --network "$name" --network-alias board \
  -v "$work/hub.js:/hub.js:ro" "$node_image" node /hub.js >/dev/null
docker run -d --name "$name-caddy" --network "$name" -p 127.0.0.1:18443:443 \
  -e KB_CHAT_DOMAIN=localhost \
  -v "$root/deploy/Caddyfile:/etc/caddy/Caddyfile:ro" \
  -v "$work/csp.caddy:/etc/caddy/csp.caddy:ro" "$caddy_image" >/dev/null

for _ in $(seq 1 30); do
  curl -sk --max-time 2 --resolve board.localhost:18443:127.0.0.1 -o /dev/null https://board.localhost:18443/ && break
  sleep 1
done

stamps="$work/stamps"
curl -skN --max-time 10 --resolve board.localhost:18443:127.0.0.1 https://board.localhost:18443/events |
  while IFS= read -r line; do
    case "$line" in data:*) echo "$(date +%s%3N) $line" >>"$stamps" ;; esac
  done

cat "$stamps"
[ "$(wc -l <"$stamps")" -eq 2 ] || { echo "expected two events through the edge" >&2; exit 1; }
first="$(sed -n 1p "$stamps" | cut -d' ' -f1)"
second="$(sed -n 2p "$stamps" | cut -d' ' -f1)"
gap=$((second - first))
echo "gap between the events: ${gap} ms"
[ "$gap" -ge 2000 ] || { docker logs "$name-caddy" >&2; echo "the edge held the events back" >&2; exit 1; }
echo "ok: live events cross the edge as they happen"
