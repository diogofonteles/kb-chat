# 0001 — Nx monorepo with Angular SPA and Fastify API

- Status: accepted (2026-10-24)
- Drivers: Q6 evolvability, Q5 contract stability; constraint: Angular frontend, pnpm

## Context

The product needs a browser UI (Angular, decided by the owner) and a server side that can spawn local processes (kb, QMD), read the vault and hold the OpenRouter key. A browser cannot do these things, so a server is required. The devflow harness ships coding standards for the `nx-angular-fastify` stack (TypeScript, Angular 21+, Node/Fastify with zod, Vitest and Playwright).

## Decision

We use one Nx 21 workspace managed by pnpm with three projects:

- `apps/web`: Angular 21 standalone, zoneless, signals and `httpResource`.
- `apps/api`: Fastify 5 in ESM TypeScript, with zod 4 through `fastify-type-provider-zod`.
- `libs/contracts`: zod schemas shared by both.

One deployable modular monolith (SB-03). In development, the web dev server proxies `/api` to the API. In release 2 the API also serves the built SPA.

## Options considered

1. **Nx + Angular + Fastify (chosen).** It matches the harness standards and the owner's other project (NaCesta), and the shared zod contracts give compile-time producer–consumer checks (CS-12).
2. **Angular SSR server with API routes.** It is a single process, but it mixes rendering with process management, and SSR is not needed for a local tool.
3. **Go API next to the kb CLI.** It is closer to kb's language, but it adds a second toolchain and gives no shared types with Angular (QA-21: considered and rejected for team skills).

## Consequences

- Good: one `pnpm` command set, types shared end to end, and the harness gates apply as-is.
- Bad: Nx adds tooling weight for a small app. We accept this for consistency with the harness.
- Compliance: Nx module-boundary tags enforced in `pnpm lint`. Revisit if a second client (mobile app) appears.
