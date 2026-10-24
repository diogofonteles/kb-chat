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
- ADRs: [`docs/adr/`](docs/adr/) — 0001 Nx/Angular/Fastify · 0002 QMD MCP search · 0003 frontmatter catalog · 0004 grounded AI answers · 0005 local-first auth seam · 0006 research agent · 0007 AI providers and local settings
- Screens: [`docs/design/screens.md`](docs/design/screens.md) · Backlog: [`docs/backlog/README.md`](docs/backlog/README.md)

## Stack

- `libs/contracts` — zod schemas shared by api and web (`@kb-chat/contracts`)
- `apps/api` — Fastify 5 + zod; reads the kb vault read-only, searches through a long-lived `qmd mcp` (fallback: `kb search`)
- `apps/web` — Angular 21 standalone, zoneless, signals + `httpResource`
- `e2e` — Playwright against the API on `apps/api/test/fixtures/vault` (in-process index)

## Run

```bash
pnpm install
pnpm dev:api     # http://127.0.0.1:3000/health (reads KB_VAULT, default ~/dev/personal/hermetismo)
pnpm dev:web     # http://localhost:4200 (proxies /api to :3000)
```

Variables: [`.env.example`](.env.example) (all optional). `OPENROUTER_API_KEY` is only needed for AI answers (KBC-004).

## Quality

```bash
pnpm lint && pnpm typecheck && pnpm test && pnpm build && pnpm format:check   # gates (coverage floor 80%)
pnpm e2e                                    # Playwright, ports 3117/4317, desktop 1440 + mobile 390
pnpm --filter @kb-chat/api latency          # p95 per search mode against a running API (Q1/Q2)
```
