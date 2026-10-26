#!/usr/bin/env bash
# The Codex sandbox (ADR 0020) must not reach the cloud's metadata service: from there an
# injected turn could get the VM's instance-principal token (the backup bucket). Docker
# creates the DOCKER-USER chain at start; this inserts the drop rule once (idempotent).
#   sudo /srv/kb-chat/deploy/scripts/codex-egress.sh       (also run by Docker's drop-in)
set -euo pipefail
# IPv4 only: the codex network has no IPv6 (Docker's default; ADR 0020).
rule=(-s 172.30.0.0/24 -d 169.254.0.0/16 -j DROP)
iptables -C DOCKER-USER "${rule[@]}" 2>/dev/null || iptables -I DOCKER-USER "${rule[@]}"
