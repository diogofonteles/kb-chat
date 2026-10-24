# 0010 — Production on one OCI Always Free Ampere VM with Docker Compose

- Status: proposed (2026-10-24); accepted when the owner runs the first deploy (KBC-012)
- Amends: [0005](0005-local-first-single-user-auth-seam.md) (the API may listen on a non-loopback interface, inside a private container network only) and [0008](0008-google-login-and-permissions.md) (the hosting follow-ups: `trustProxy`, `Secure` behind the proxy, the session sweep)
- Drivers: KBC-012 (use kb-chat away from the Mac and share it with invited people), Q3 cost (stay at US$ 0 of infrastructure), Q2 latency (QMD keeps its models warm), Q7 vault safety, the KBC-010 sign-in

## Context

Release 1 runs on the owner's Mac. KBC-010 added Google sign-in and per-person permissions, so the app can now be reached from the internet. The owner asked for production on Oracle Cloud Infrastructure (OCI) Always Free, with no cloud account or CLI yet: everything must be ready to run.

The constraints that shape the decision were checked on 2026-10-24:

- **Compute.** Since June 2026, Always Free gives 1,500 OCPU-hours and 9,000 GB-hours per month of `VM.Standard.A1.Flex` (Ampere, arm64). That is **2 OCPUs and 12 GB of RAM**, down from 4 and 24 ([Oracle docs](https://docs.oracle.com/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm), [InfoQ, 2026-07](https://www.infoq.com/news/2026/07/oracle-cloud-free-tier-limits/)).
- **Storage and network.** 200 GB of block storage in total (boot and block volumes, boot minimum 47 GB), 5 volume backups, 20 GB of Object Storage, 10 TB of egress per month, and up to 2 VCNs.
- **Idle reclamation.** An Always Free instance may be stopped when, over 7 days, CPU p95, network and (on A1) memory all stay below 20%. Oracle's notice says that converting the account to Pay As You Go (PAYG) avoids it, with no charge while usage stays inside Always Free.
- **Host firewall.** Oracle's Ubuntu images ship iptables rules that reject everything but SSH, even when the security list allows a port.
- **The runtime.** It must carry `qmd` 2.8.3 (node-llama-cpp, better-sqlite3, sqlite-vec and tree-sitter, all native) and `kb` 0.0.12. It must also carry Claude Code 2.1.310 for the owner's subscription (ADR 0007). All three install on linux-arm64. QMD on CPU with Node 22 was verified in a container on Apple Silicon.
- **Subscription terms.** Claude Code's terms allow a person to sign in to the unmodified Claude Code binary with their own subscription, including where a platform hosts it. They forbid routing other people's requests through Free, Pro or Max credentials ([legal and compliance](https://code.claude.com/docs/en/legal-and-compliance)). KBC-010 BR-5 already limits the subscription to the owner.

## Decision

**One VM, one Compose project.** Production runs on a single `VM.Standard.A1.Flex` with 2 OCPUs and 12 GB (Ubuntu 24.04 aarch64). It runs `deploy/compose.yml`:

- `web`: Caddy 2.10 with the built SPA and the Caddyfile baked in. It is the only published service (80/443 tcp, 443 udp). It provides automatic HTTPS (Let's Encrypt), zstd/gzip, security headers, a CSP generated from the built `index.html` that allows Google Identity Services, and the SPA fallback. It proxies `/api/*` (streaming) and `/health` to the API. `/mcp*` answers 404.
- `api`: Node 22 bookworm-slim with `qmd`, `kb` and `claude`. It runs as uid 10001 with tini as PID 1, all capabilities dropped and no published port. It listens on `0.0.0.0` inside the private network (`HOST`) and trusts `X-Forwarded-For` only from private addresses (`TRUST_PROXY=uniquelocal`).
- The MCP endpoint of research turns also refuses any non-loopback socket at the API, so only the CLIs that the API spawns reach it.

**Data on a block volume** mounted at `/srv/kb-chat`:

- `vault/` is mounted read-only (Q7);
- `qmd/` holds the index and models;
- `state/` holds conversations, settings, spend, usage, people and sessions;
- `claude/` holds the owner's Claude Code login;
- `deploy/` holds the root-owned `.env`, mode 0600, the only place secrets live.

The instance can be rebuilt without losing data, and the reserved public IP survives a rebuild.

**Environments.** Only production is hosted. The owner's Mac is the staging environment (`pnpm dev`, the E2E suite, and `docker compose` with the same images on `localhost`). There is no second VM or subdomain for staging:

- it would halve the 12 GB the A1 allowance gives;
- it would double the QMD models in memory;
- the promotion flow is `develop → main`, and `main` is the owner's release decision.

**The vault never goes through GitHub.**
- `deploy/scripts/sync-vault.sh`, run on the Mac, uses rsync over SSH to send the topic folders. It refuses a vault with no topics and has a dry run. It counts the deletions with an rsync dry run first and refuses before sending anything when they pass `--max-delete`.
- It then sends a consistent SQLite snapshot of the QMD index and the QMD config, with paths rewritten to `/vault`.
- On the VM, `install-index.sh` swaps the index in and restarts the API; if the smoke fails, the previous index goes back.
- Embeddings stay on the Mac (Metal); the VM only queries.

**Deploy = merge to `main`.** `.github/workflows/deploy.yml` runs in three steps:

1. **Build.** It builds both images natively on `ubuntu-24.04-arm` (available to private repositories since 2026-01) and pushes them to GHCR, tagged with the commit SHA.
2. **Deploy.** It connects over SSH with a key whose `authorized_keys` entry is `restrict,command="…/ci-gate.sh"`. That key can only ask for `deploy <sha> <user>`, `smoke` or `release`. The registry token is the job's short-lived `GITHUB_TOKEN`, sent on stdin; the VM logs out after pulling.
3. **Check.** It checks that the image tag the containers actually run (`docker ps`, not `release.env`) equals the commit SHA, then smokes from the internet.

The actions are pinned by commit SHA and kept current by Dependabot. Both jobs run only on `refs/heads/main`, a manual run included.

On the VM, `deploy.sh` runs the release:

- it holds a lock (`flock`) shared with `rollback.sh`, `install-index.sh` and `restore-state.sh`;
- it refuses an `.env` without `KB_CHAT_DOMAIN`, `GOOGLE_CLIENT_ID` or `KB_CHAT_OWNER_EMAIL`;
- it pulls without touching `release.env`, then refuses images whose `org.opencontainers.image.revision` label is not the requested SHA;
- it copies the `compose.yml` and scripts shipped inside that release's API image to a staging folder and swaps them in by rename;
- it runs `docker compose up --wait`, checks the running tag and runs the smoke;
- any failure in those steps (deploy files, `up`, running tag, smoke) puts the previous release back, and an exit trap restores `release.env` if the script is interrupted.

The smoke checks four things:
- `/health`;
- the SPA shell with CSP and HSTS;
- `/mcp` is 404 from outside;
- `/api/v1/topics` is 401 without a session.

The images of the last five live releases stay on the VM. `rollback.sh` returns to any of them without the registry. A release rolled back from is recorded in `rolled-back.list`, so a second rollback keeps going back instead of returning to it; a new deploy of that SHA clears the mark.

**Backups.**
- A systemd timer runs `backup-state.sh` every day. It streams `state/`, `claude/` and the `.env` through `tar | age` to the owner's public key (no plaintext archive on disk), then uploads the result to a private Object Storage bucket with the instance principal, so no API key sits on the VM.
- The dynamic group matches the kb-chat compartment, so a rebuilt VM keeps its rights. The policy grants only `OBJECT_CREATE` and `OBJECT_INSPECT` on that bucket, and uploads use `--no-overwrite`: a compromised VM cannot delete or replace backups.
- The bucket's lifecycle policy deletes `state/` objects after 30 days, applied by the Object Storage service, not the VM.
- Restore decrypts on the Mac and streams the archive to `restore-state.sh`. It refuses links and unexpected paths, extracts to a staging folder, and keeps the previous state aside.
- A daily timer deletes session files untouched for 31 days. Sessions expire 30 days after their last refresh, and each refresh rewrites the file.

**First boot.** The subnet has no NAT gateway, so the reserved public IP is the VM's only way out. `provision.sh` binds it right after the launch, before the block volume. cloud-init uses no module that needs the network. A single `kb-chat-setup` script waits for egress, mounts the data volume, installs the packages (checking Docker's signing key fingerprint), and writes the done marker only after it verifies the mount, Docker, the compose plugin and the OCI CLI. A missing volume fails the setup: there is no fallback to the boot volume. `docker.service` has `RequiresMountsFor=/srv/kb-chat`, so after a reboot the containers never start on an empty mount point.

**Host hardening (cloud-init).**
- SSH: keys only, no root login, `AllowUsers ubuntu deploy`.
- The `deploy` user may only run the deploy and smoke scripts through sudo.
- fail2ban guards sshd.
- unattended-upgrades applies security updates and reboots at 05:30 UTC when a kernel update needs it.
- Docker logs rotate, and a 4 GB swap file is added.
- The VCN is IPv4 only. With Docker's userland proxy on, IPv6 or hairpin traffic would reach Caddy from the bridge gateway, putting those clients in one rate-limit bucket. That is acceptable while there is no IPv6.
- iptables accepts 80/443 before Oracle's REJECT rule.
- The security list allows only 22 (from `SSH_SOURCE_CIDR`), 80 and 443.

A security list on the subnet is chosen over an NSG: there is one VNIC and one role, so per-VNIC rules buy nothing.

**Cost guard.**
- `deploy/oci/provision.sh` refuses sizes above the allowance, and anything that is not a positive integer (`3.0`, `2.5`, `0`).
- It creates a US$ 1 monthly budget with an alert at the first cent.
- The recommended mitigation for idle reclamation is converting to PAYG, which keeps Always Free resources free and is never stopped as idle. No CPU or memory burner is installed.

## Deployment diagram (AD-04)

```mermaid
C4Deployment
title Deployment — kb-chat production (OCI Always Free, one region)
Deployment_Node(mac, "Owner's Mac", "macOS, Apple Silicon") {
  Container(kb, "kb + qmd", "CLIs", "Ingests the vault, builds the QMD index with Metal")
}
Deployment_Node(gh, "GitHub", "Actions + GHCR") {
  Container(ci, "deploy.yml", "ubuntu-24.04-arm runner", "Builds arm64 images, deploys by SHA, smokes")
  ContainerDb(ghcr, "GHCR", "Container registry", "kb-chat-api and kb-chat-web tagged by commit SHA")
}
Deployment_Node(oci, "OCI tenancy", "Always Free, home region") {
  Deployment_Node(vcn, "VCN 10.42.0.0/16", "Public subnet; security list 22/80/443") {
    Deployment_Node(vm, "kb-chat-vm", "VM.Standard.A1.Flex, 2 OCPU, 12 GB, Ubuntu 24.04 aarch64") {
      Deployment_Node(dc, "Docker Compose project kb-chat", "private bridge network") {
        Container(web, "web", "Caddy 2.10", "TLS, SPA, CSP, proxies /api and /health; /mcp is 404")
        Container(api, "api", "Node 22, Fastify 5", "Search, research, sign-in; spawns qmd mcp, kb, claude")
      }
      ContainerDb(vol, "Block volume /srv/kb-chat", "ext4, 50 GB", "vault (ro), qmd index, state, claude login, .env")
    }
  }
  ContainerDb(bucket, "kb-chat-backups", "Object Storage, private", "Daily age-encrypted state archives, 30 days")
}
Person(user, "Signed-in person", "Browser")
System_Ext(google, "Google Identity Services", "ID tokens")
System_Ext(llm, "AI providers", "Claude via Claude Code, OpenRouter, OpenAI")
Rel(user, web, "Uses", "HTTPS 443")
Rel(web, api, "Proxies /api and /health to", "HTTP 3000, private network")
Rel(api, vol, "Reads the vault and writes state to", "bind mounts")
Rel(api, google, "Verifies ID tokens against", "HTTPS")
Rel(api, llm, "Requests research turns from", "HTTPS")
Rel(vm, bucket, "Uploads encrypted backups to", "HTTPS, instance principal")
Rel(kb, vol, "Sends the vault and index snapshot to", "rsync over SSH")
Rel(ci, ghcr, "Pushes images to", "HTTPS")
Rel(ci, vm, "Asks for deploy of one SHA", "SSH, forced command")
Rel(vm, ghcr, "Pulls the release images from", "HTTPS, job token")
```

Legend: Deployment_Node = machine, runtime or network boundary. Container = runnable unit. ContainerDb = data store. Person = user role. System_Ext = a third-party service.

## Threat model (CS-17)

1. **What are we building?** A public HTTPS endpoint in front of an API that reads a private vault and holds third-party credentials (provider keys, the owner's Claude login, Google sessions). It also includes an SSH deploy path from GitHub.
2. **What can go wrong, and what we do about it?**

| Threat | Mitigation |
|---|---|
| Unauthenticated use of the API or of AI credit | KBC-010 guard on every route; smoke asserts 401 without a session; per-IP rate limits made real by `TRUST_PROXY` |
| Cookie theft over HTTP | HSTS, HTTP→HTTPS redirect, `Secure` cookie (the proxied `Host` is the public name), `SameSite=Lax`, CSRF Origin check against `WEB_ORIGIN` |
| XSS stealing the session or calling the API | CSP with hashed inline code only, no `unsafe-inline` scripts; `frame-ancestors 'none'`; markdown sanitized (ADR 0004) |
| Reaching the MCP turn endpoint from outside | Caddy 404 on `/mcp*`, API refuses non-loopback sockets, per-turn token (ADR 0007) |
| DNS rebinding or a forged `Host` | `ALLOWED_HOSTS` = the domain plus loopback |
| A stolen CI key | `restrict` + forced command: only `deploy <sha>`, `smoke`, `release`; no shell, no forwarding; sudo limited to two scripts; images must exist in GHCR for the repository |
| A GHCR push is root on the VM: `deploy.sh` runs, as root, the compose file and scripts taken from the API image, so anyone who can push `kb-chat-api` (a workflow with `packages: write`, a compromised action) controls the host | `packages: write` only in the build job of `deploy.yml`; every action pinned by commit SHA (Dependabot updates); deploys only from `main`; `deploy.sh` refuses images whose `org.opencontainers.image.revision` label is not the requested SHA, and the SHA must be the commit the workflow built. A signed provenance check (`gh attestation verify`) is the next step if more workflows ever get `packages: write` |
| Leaked registry credentials on the VM | None stored: the job token lives for minutes and the VM logs out after the pull |
| Secrets in git or logs | Only in the root-owned `.env` (0600) and GitHub environment secrets; `.env` and `oci.env` ignored; pino redaction (ADR 0007) |
| Brute force on SSH | Keys only, fail2ban, `AllowUsers`; optional `SSH_SOURCE_CIDR` |
| Unpatched host | unattended-upgrades with automatic reboot; Docker from its official repository |
| Lost data (instance reclaimed or rebuilt) | Data on a separate block volume, reserved IP, daily encrypted off-VM backup, vault and index rebuildable from the Mac |
| A backup leaks | `age` encryption to a key that is never on the VM; private bucket; policy limited to that bucket |
| A compromised VM erases the backups | The VM may only create and inspect objects; no overwrite; retention is the bucket's lifecycle policy |
| A wrong sync wipes the vault | Refuses an empty vault; counts deletions with a dry run and refuses above `--max-delete` before sending; read-only mount in the API |
| Terms violation with the Claude subscription | Only the owner, signed in to the unmodified Claude Code binary (KBC-010 BR-5); guests bring their own keys |

3. **Did we do a good job?**
   - Smoke checks (401, `/mcp` 404, CSP and HSTS) run on every deploy.
   - Unit and integration tests cover the loopback-only MCP, the config defaults and `TRUST_PROXY` (`buildApp` + `inject` with forged `X-Forwarded-For`).
   - Revisit with any new public route, a second instance, or a change in Oracle's limits.

## Operability (CS-21 to CS-25)

- **Config:**
  - `deploy/.env` (template `deploy/.env.example`);
  - `release.env` (the image tag) is written only by `deploy.sh`.
- **Logs:**
  - Caddy access logs are JSON on stdout;
  - the API logs with pino;
  - both rotate through Docker (10 MB × 5);
  - read them with `docker compose logs`.
- **Health:**
  - the API container healthcheck hits `/health` on loopback;
  - `/health` returns 200 with `degraded` when QMD is down and search runs through `kb`;
  - the smoke runs on every deploy and from GitHub.
- **Lifecycle:**
  - `restart: unless-stopped`;
  - `live-restore` keeps containers up during a Docker upgrade;
  - SIGTERM goes through tini to Fastify's graceful close.
- **Rollback:**
  - automatic when the smoke fails;
  - by hand with `rollback.sh [sha]`.
- **Runbook:** `docs/deploy/runbook.md`.

## Options considered

1. **OCI Always Free VM with Docker Compose and Caddy (chosen).**
   - Pros:
     - US$ 0;
     - 12 GB of RAM, enough for the QMD embedding model, which a small PaaS machine cannot hold for free;
     - the same images run locally;
     - full control of the CLIs the API spawns.
   - Cons:
     - the owner runs the host (patches, backups);
     - the A1 allowance can change, as it did in 2026;
     - idle reclamation unless the account moves to PAYG;
     - a single instance with no redundancy.
2. **Fly.io, like NaCesta.**
   - Pros:
     - managed machines and TLS, `fly deploy`;
     - the owner already knows it.
   - Cons:
     - no free allowance for a 2–4 GB machine with a volume;
     - the QMD models and the Claude Code login need a volume and memory that cost about US$ 10–30/month;
     - the stateful single-writer state dir fits a VM better than scale-to-zero machines.
3. **The owner's Mac exposed through a tunnel (Cloudflare Tunnel or Tailscale Funnel).**
   - Pros:
     - zero infrastructure;
     - Metal for QMD;
     - the vault is already there.
   - Cons:
     - availability is tied to the laptop being awake and online;
     - a public entry point into the personal machine;
     - the tunnel provider sees the traffic.

## Consequences

- New operational duties for the owner: the account, DNS, the Google origin, the Claude login and vault syncs (KBC-012 lists them).
- The API gained `HOST` and `TRUST_PROXY` (defaults keep the local behaviour) and the loopback-only MCP check. The subscription CLI also receives `DISABLE_AUTOUPDATER`: the image pins its version.
- The global CLIs in the API image (`qmd`, `kb`, Claude Code) are installed with `pnpm add -g` (pnpm 9.15.0 under `/opt/clis`), like the workspace, with pinned versions.
- Production images are arm64 only; an amd64 host would need `platforms: linux/amd64,linux/arm64` in the workflow.
- A release changes `compose.yml` and the scripts together with the code: they ship inside the API image.
- Compliance check (AD-15):
  - the deploy workflow's smoke and SHA match;
  - `provision.sh` refuses sizes above Always Free;
  - the budget alert.
- Revisit when:
  - Oracle changes the allowance again;
  - a second instance or a staging VM is needed;
  - the vault outgrows the volume.
