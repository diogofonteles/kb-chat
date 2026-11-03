# CLAUDE.md

Operational facts only; decisions live in `docs/` (product, design, architecture and ADRs, backlog).

## Rules (reference)

- Harness goal routine: [`.claude/CLAUDE.devflow.md`](.claude/CLAUDE.devflow.md) (imported via `.claude/CLAUDE.md`)
- Package manager: **pnpm only** (never npm/yarn)
- Languages: chat and work artifacts (`docs/product`, `docs/design`, `docs/research`, `docs/backlog`, `work/`) in pt-BR; code, comments, commits, branches, file names and `docs/architecture`/`docs/adr` in English; UI text pt-BR via `$localize`/`i18n`
- Commits: Conventional Commits in English, no AI mentions
- Branches: `feature/*`, `fix/*`, `chore/*`, `docs/*` from updated `develop` → PR to `develop`; `develop → main` is the owner's release decision

## Architecture (reference)

- [`docs/architecture/overview.md`](docs/architecture/overview.md) — drivers, C4, modules, contracts, threat model
- ADRs: [`docs/adr/`](docs/adr/) — 0001 Nx/Angular/Fastify · 0002 QMD MCP search · 0003 frontmatter catalog · 0004 grounded AI answers · 0005 local-first auth seam (superseded) · 0006 research agent · 0007 AI providers and local settings · 0008 Google login and permissions · 0009 faster research (profiles, auto-escalation, streaming with retract) · 0010 production on OCI Always Free (Compose, Caddy) · 0011 access requests and one-time codes (Resend, SMS off) · 0012 Gmail SMTP as the free email provider · 0013 exhaustive research (grep-like tools, paging, filters, exhaustive profile, compaction) · 0014 research sub-agents (orchestrator, parallel workers) · 0015 authorship in the catalog, search contract and research tools (Mestre Laércio × other authors) · 0016 the house AI plan, the AI access policy, no AI defaults in production · 0017 AI keys sealed at rest (`KB_CHAT_SECRETS_KEY`) · 0018 one's own AI (Gemini, OpenRouter on free models by OAuth, guided setup) · 0019 the owner lends his Claude subscription to chosen people · 0020 Codex runs in a sandbox container, through a runner · 0021 the exhaustive profile's app-driven sweep and coverage measured by the app · 0030 authors per collection in the app's state, with one main author
- Screens: [`docs/design/screens.md`](docs/design/screens.md) (T10: request access, code sign-in) · Backlog: [`docs/backlog/README.md`](docs/backlog/README.md)

## Stack

- `libs/contracts` — zod schemas shared by api and web (`@kb-chat/contracts`)
- `apps/api` — Fastify 5 + zod; reads the kb vault read-only, searches through a long-lived `qmd mcp` (fallback: `kb search`)
- `apps/web` — Angular 21 standalone, zoneless, signals + `httpResource`
- `e2e` — Playwright against the API on `apps/api/test/fixtures/vault` (in-process index)

## Run

```bash
pnpm install
pnpm dev:api     # http://127.0.0.1:3000/health (reads the root .env; KB_VAULT default ~/dev/personal/hermetismo)
pnpm dev:web     # http://localhost:4200 (proxies /api to :3000)
```

Variables: [`.env.example`](.env.example), loaded from the repository root `.env` (gitignored). `GOOGLE_CLIENT_ID` and `KB_CHAT_OWNER_EMAIL` are required: sign-in with Google is mandatory (KBC-010, ADR 0008), and Google only accepts the button on the client's authorized origins (`http://localhost:4200`). A git worktree has no `.env`: copy the main checkout's. Access requests and one-time code sign-in (KBC-014, ADR 0011/0012) send email through Gmail SMTP with an app password (`SMTP_USER`, `SMTP_PASSWORD`; `SMTP_HOST`/`SMTP_PORT` default `smtp.gmail.com`/465) or, without that pair, Resend (`RESEND_API_KEY`, `KB_CHAT_EMAIL_FROM`); with neither the codes are printed in the API log (development only). With `NODE_ENV=production` the API refuses to start without one complete provider, and half of the SMTP pair stops it in any environment. SMS is off (`KB_CHAT_SMS=off`; `log` for development). The AI provider is chosen in ⚙ Configurações (KBC-007, ADR 0007); a master lends the app's AI in "IA da aplicação" (KBC-022, ADR 0016). With nothing chosen, the old local defaults (the Claude subscription when `claude` is on PATH, then `OPENROUTER_API_KEY`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`) apply only with `KB_CHAT_AI_DEFAULTS=local` in `.env` (refused in production). AI keys on disk are sealed with `KB_CHAT_SECRETS_KEY` (base64, 32 bytes; locally, without it, `<KB_CHAT_STATE_DIR>/secrets.key` is created once).

## Deploy (production, ADR 0010)

- Production only: one OCI Always Free A1 VM (2 OCPU, 12 GB); the Mac is staging. Merge to `main` (the owner's decision) runs [`.github/workflows/deploy.yml`](.github/workflows/deploy.yml): arm64 images in GHCR tagged by SHA, SSH deploy, smoke, automatic rollback.
- Files: [`deploy/`](deploy/) (compose, Caddyfile, cloud-init, scripts, `oci/` provisioning), `apps/api/Dockerfile`, `apps/web/Dockerfile`. Step by step: [`docs/deploy/runbook.md`](docs/deploy/runbook.md).
- Local image smoke (ports 8080/8443; fixture vault indexed by QMD in the container, see the runbook):

```bash
docker build -f apps/api/Dockerfile -t kb-chat-api:local . && docker build -f apps/web/Dockerfile -t kb-chat-web:local .
KB_CHAT_TAG=local KB_CHAT_REGISTRY=docker.io/library KB_CHAT_DOMAIN=localhost KB_CHAT_DATA=<dir> HTTP_PORT=8080 HTTPS_PORT=8443 \
  WEB_ORIGIN=https://localhost:8443 GOOGLE_CLIENT_ID=<id> KB_CHAT_OWNER_EMAIL=<email> KB_CHAT_SECRETS_KEY="$(openssl rand -base64 32)" \
  SMTP_USER=smoke@example.com SMTP_PASSWORD=unused docker compose -f deploy/compose.yml up -d --wait
SMOKE_INSECURE=1 deploy/scripts/smoke.sh https://localhost:8443
```

## Quality

```bash
pnpm lint && pnpm typecheck && pnpm test && pnpm build && pnpm format:check   # gates (coverage floor 80%)
pnpm tutorial:screenshots                   # regenerates the /tutorial pictures (KBC-032, README)
pnpm e2e                                    # Playwright, ports 3117/4317 (KBC_E2E_API_PORT/KBC_E2E_WEB_PORT to move them), desktop 1440 + mobile 390
pnpm --filter @kb-chat/api latency          # p95 per search mode against a running API (Q1/Q2)
(cd tools/transcriber && uv run ruff check && uv run ruff format --check && uv run pytest)   # the Mac transcriber (KBC-036, Python with uv)
pnpm --filter @kb-chat/api exec tsx src/scripts/transcript-calibration.ts <raw-dir>   # post-filter and confidence over raw transcripts (manual, ADR 0023)
```
