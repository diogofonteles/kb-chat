# Architecture overview — kb-chat

Sources: `docs/product/context.md`, `docs/product/vision.md`, `docs/product/brief.md`, `docs/design/screens.md`. ADRs in `docs/adr/`.

## Drivers (QA-01, QA-03)

Ranked, each traced to a business driver from the brief:

1. **Find the right passage fast** (brief: "the most important quality"). Relevance plus latency.
2. **Predictable AI cost** (constraint: OpenRouter credit is limited and already ran out once).
3. **Evolvability to hosted multi-user** (decided: local first, invited users with login in release 2) without a rewrite.

Fixed constraints: Angular frontend; pnpm; the vault is produced and owned by the `kb` CLI (0.0.12, unstable) and indexed by QMD 2.8.3, which needs Node 24 via the `~/.local/bin/qmd` wrapper; code and docs in English, UI in pt-BR.

### Quality attribute scenarios (QA-02, QA-05)

| ID | Quality | Stimulus / environment | Response (measurable) | Importance / difficulty |
|---|---|---|---|---|
| Q1 | Latency, exact | A question in "Palavras exatas" mode, local Mac, warm API | Results rendered p95 ≤ 1 s | H / L |
| Q2 | Latency, semantic and hybrid | A question in "Por significado" or "Tudo" mode, warm API | p95 ≤ 2 s (vec), ≤ 4 s (hybrid); progress shown within 400 ms | **H / H** |
| Q3 | Cost | One "Responder com IA" click | ≤ US$ 0.02 per answer; daily spend never exceeds the configured cap (default US$ 1) | H / M |
| Q4 | Grounding | An AI answer | Every claim cites a retrieved source; with no supporting source it says so | H / M |
| Q5 | Contract stability | A kb or qmd upgrade changes the JSON output | A failing contract test before any user sees broken results | M / L |
| Q6 | Evolvability | Release 2 adds login and hosting | Auth and per-user limits added behind existing ports; search and AI modules unchanged | M / M |
| Q7 | Safety of the vault | Any API request | The API never writes to the vault or the QMD index | H / L |

Spike result to record in ADR 0002 (QA-18): measured on 2026-10-23 while `qmd embed` was running concurrently, so the numbers are pessimistic. Cold `kb search --lex` took 0.68 s; cold `kb search` (hybrid, with query expansion and reranking through local models) took 118 s. Q2 is the riskiest scenario. The walking skeleton measures warm vec and hybrid latency through a long-lived QMD process before any further depth is added.

### ISO 25010 walk (QA-04)

Addressed: performance efficiency (Q1, Q2), functional suitability (Q4), maintainability (Q5, Q6), security (Q7, threat model below), usability (`docs/design/screens.md`). Deprioritised: availability (single local user, restart is fine), scalability (one user in R1). Not applicable in R1: compatibility with other clients, portability beyond macOS.

## Style (SB-01, SB-03)

**One deployable modular monolith**: an Angular SPA served by a Fastify API. Both live in one Nx workspace, sharing zod contracts. The API wraps the vault through **ports and adapters** (SB-13): the core never spawns processes or reads files directly. No microservices (SB-02); there is no driver for independent deployment.

## C4 — System context (AD-01)

```mermaid
C4Context
title System context — kb-chat (release 1, local)
Person(student, "Student", "Researches an ingested kb collection")
System(kbchat, "kb-chat", "Chat-style search and reading over kb vaults")
System_Ext(vault, "kb vault", "Markdown topics with frontmatter facets and relations, written by the kb CLI")
System_Ext(qmd, "QMD", "Local hybrid/lexical/vector index over the vault")
System_Ext(openrouter, "OpenRouter", "Paid LLM API used only on explicit request")
System_Ext(google, "Google Identity Services", "Sign-in button and ID tokens; public keys (JWKS)")
Rel(student, google, "Signs in with", "browser")
Rel(kbchat, google, "Verifies ID tokens with the keys of", "HTTPS, cached")
Rel(student, kbchat, "Asks questions, filters and reads documents in", "browser")
Rel(kbchat, vault, "Reads documents, facets and relations from", "filesystem, read-only")
Rel(kbchat, qmd, "Runs searches through", "MCP over stdio")
Rel(kbchat, openrouter, "Requests grounded answers from", "HTTPS")
```

Legend: Person = user role; System = this product; System_Ext = existing system outside this repository.

## C4 — Containers (AD-02, AD-03)

```mermaid
C4Container
title Container diagram — kb-chat (release 1, local)
Person(student, "Student")
Container(web, "Web app", "Angular 21, zoneless, signals", "Chat UI, filter chips, document panel, themes")
Container(api, "API", "Node 22+, Fastify 5, zod", "Search, facets, documents, relations, AI answers, spend ledger")
ContainerDb(catalog, "Catalog", "In-memory index built from frontmatter", "Per-document facets, title, summary, relations")
ContainerDb(ledger, "Local state", "JSONL and JSON files in ~/.kb-chat/", "AI spend ledger, usage events and saved conversations")
System_Ext(vault, "kb vault", "Markdown files")
System_Ext(qmd, "QMD MCP server", "Long-lived child process of the API, Node 24")
System_Ext(openrouter, "OpenRouter")
Rel(student, web, "Uses", "HTTPS, browser")
Rel(web, api, "Calls", "JSON over HTTP; answers stream as SSE events sources, token, done or error")
Rel(api, catalog, "Builds at startup and on file changes, then queries")
Rel(api, vault, "Reads markdown and frontmatter from", "fs, read-only")
Rel(api, qmd, "Sends query and get calls to", "MCP stdio")
Rel(api, ledger, "Appends spend and events to")
Rel(api, openrouter, "Streams completions from", "HTTPS, key in env")
```

Legend: Container = runnable unit or data store in this repository; ContainerDb = data store; System_Ext = outside this repository.

## Modules and dependency rules (SB-04, SB-05, SB-06)

Nx workspace (pnpm):

```
apps/web                 Angular SPA: features/chat, features/document, features/settings, core (http, theme, i18n)
apps/api                 Fastify: modules/*, adapters/*, server.ts (composition root)
libs/contracts           zod schemas + inferred types shared by web and api (the only shared lib)
```

API modules, organised by business capability:

| Module | Owns | Public API |
|---|---|---|
| `topics` | List of topics in the vault | `listTopics()` |
| `catalog` | In-memory facet catalog per topic (facets, title, summary, concepts, relations, duplicate groups) | `getCatalog(topic)`, `facetCounts(ids)` |
| `search` | Search modes, over-fetch and post-filter, duplicate grouping, snippet cleanup | `search(query)` |
| `documents` | Document body without frontmatter, highlight positions, "see also" | `getDocument(topic, id)` |
| `research` | Research agent (ADR 0006): tools over the index, summaries and relations, the tool loop | `ToolLoopRunner.run(turn)` (stream), `ResearchTools` |
| `spend` | Spend ledger, daily cap and credit checks (ADR 0004) | `SpendService.guard(usd)`, `record(turn)`, `today()` |
| `usage` | Local event log for the research plan | `record(event)` |
| `conversations` | The complete conversation history (search and research), no cap, keyed by principal | `list(principal, filter)`, `get(principal, id)`, `save(principal, conversation)`, `remove(principal, id)` |
| `auth` | Google sign-in, one-time code sign-in, sessions, people and their permissions (ADR 0008, ADR 0011) | `PeopleService`, `SessionService`, `OneTimeCodes`, `SendLimits`, `RequestTickets`, `Notifier`, `authRoutes`, `codeRoutes`, `peopleRoutes`, `principalOf(request)`, `RouteAccess` |
| `access-requests` | Asking for access (form or Google) and the masters' decisions (KBC-014, ADR 0011); depends on `auth` through its barrel | `AccessRequestService`, `SignUpFlow`, `accessRequestRoutes` |

Ports (interfaces in the module) and their adapters (in `adapters/`):

- `SearchIndexPort` → `QmdMcpAdapter`, the primary adapter (a long-lived `qmd mcp` child; ADR 0002), and `KbCliSearchAdapter`, the fallback (`kb search --format json` via `execFile`, no shell).
- `VaultReaderPort` → `FsVaultAdapter` (read-only, path-confined to the vault root).
- `LlmPort` → `OpenRouterAdapter`.
- `LedgerPort` → `JsonlLedgerAdapter`.
- `IdentityVerifierPort` → `GoogleIdTokenVerifier` (JWKS cached per Cache-Control; the E2E server uses its own test keys).
- `PeopleStorePort` → `JsonPeopleStore` (`people.json`, 0600); `SessionStorePort` → `FsSessionStore` (`sessions/<sha256>.json`, 0600).
- `DocumentStorePort` → `JsonDocumentStore` (`codes.json`, `access-requests.json`, 0600, atomic); `EmailSenderPort` → `ResendEmailSender` (production), `LogEmailSender` (development), `MemoryOutbox` (tests, E2E); `SmsSenderPort` → `LogSmsSender` (development only; no production provider yet, ADR 0011).
- The access guard (`plugins/auth-guard.ts`) reads each route's `config.access`; `plugins/route-access.ts` refuses an `/api/v1` route without one (ADR 0008, replacing ADR 0005's seam).

Dependency rules, enforced by `eslint-plugin-boundaries` or Nx module-boundary tags in CI (SB-06, QA-15):

- `apps/web` may import only `libs/contracts`.
- `apps/api` modules import other modules only through their `index.ts`.
- Modules never import from `adapters/`; only `server.ts` wires them.
- `libs/contracts` imports nothing from the apps.

## Data ownership

- **The vault is owned by kb.** kb-chat is read-only (Q7). The catalog is a derived, rebuildable cache, never a second source of truth.
- **Frontmatter keys read:** `title`, `summary`, `genre`, `depth`, `relevance`, `concepts`, `example_of`, `extends`, `related`, `type`, `stage`, `ingest_batch`. A missing key means the facet value "(none)" and is hidden in the UI.
- **Duplicate groups** (same normalized title, e.g. `a-natureza-s-tupla-2.md` and `-5.md`) are computed in the catalog, and search returns the best-scoring member with `duplicates: n`.
- **Spend ledger and usage events:** owned by `spend` and `usage`, stored under `~/.kb-chat/`, with 90-day retention for events (research plan).
- **People and sessions:** owned by `auth`: `~/.kb-chat/people.json` and `~/.kb-chat/sessions/` (0600). Every per-person store is keyed by principal: the Google `sub`, except the owner, who keeps the `owner` alias of the data written before logins.
- **Access requests and one-time codes:** owned by `access-requests` and `auth`: `~/.kb-chat/access-requests.json` (pending and recently refused requests, with name, email and phone) and `~/.kb-chat/codes.json` (salted scrypt hashes only, 10 min), both 0600 (ADR 0011).
- **Conversations:** owned by `conversations`, one JSON file per conversation in `~/.kb-chat/conversations/<uuid>.json` (mode 0600, written to a temp file and renamed), kept forever; unreadable files are skipped with a warning.

## Contracts (CS-01, CS-08, CS-09, CS-11)

HTTP JSON API under `/api/v1` (versioned by path). The zod schemas in `libs/contracts` are the contract; Fastify is typed from them through `fastify-type-provider-zod`, and an OpenAPI document is generated from the same schemas.

| Method and path | Purpose |
|---|---|
| `GET /api/v1/topics` | Topics with document counts |
| `GET /api/v1/topics/{topic}/facets` | Facet values with collection-wide counts |
| `POST /api/v1/topics/{topic}/searches` | Body `{ q, mode: all\|exact\|semantic, filters, cursor? }` → `{ items[], facets (counts over the result set), total, nextCursor, tookMs }`; POST because the filters are structured, with no side effect beyond the usage event |
| `GET /api/v1/topics/{topic}/documents/{id}` | Body markdown without frontmatter, facets, summary, see-also groups, highlight terms |
| `POST /api/v1/topics/{topic}/research` | One research turn for `{ question, history, profile }`: streams (SSE) `step`, `sources`, `token` (with its `segment`), `retract`, `done` (cost, steps) or `error` (ADR 0006, ADR 0009); rate-limited, the daily cap checked before every model call |
| `GET /api/v1/spend/today` | Spend today and the cap |
| `GET /api/v1/spend/people` | Owner only: each person's spend today (BR-6) |
| `GET /api/v1/conversations` | Every saved conversation as summaries, newest first by `updatedAt`; optional `?kind=search\|research&topic=` |
| `GET` / `PUT` / `DELETE /api/v1/conversations/{id}` | One conversation (uuid id): read, upsert (path id must equal body id; answers with the summary), remove (204, idempotent) |
| `GET /api/v1/auth/config` | Public: the Google client id for the sign-in button |
| `POST /api/v1/auth/google` | Public, rate-limited: `{ credential }` (Google ID token) → the person (`Me`) and the session cookie; 403 `NOT_INVITED` |
| `POST /api/v1/auth/logout` | Ends the session (204) |
| `POST /api/v1/auth/code`, `POST /api/v1/auth/code/verify` | Public, limited: a one-time code by email or SMS (always 202) and its exchange for the session (400 `INVALID_CODE`) (ADR 0011) |
| `POST /api/v1/access-requests/signup`, `.../signup/verify`, `.../google` | Public, limited: ask for access with the form (email code first) or with the ticket of a not-invited Google sign-in |
| `GET /api/v1/access-requests`, `POST .../{id}/approve`, `POST .../{id}/refuse` | Masters only: pending requests, approve (the person with the invite defaults), refuse (24 h before asking again) |
| `GET /api/v1/me` | Who is signed in: email, name, picture, role, features, visible collections, `isOwner` |
| `GET` / `POST /api/v1/people`, `PATCH` / `DELETE /api/v1/people/{id}` | Masters only: list, invite, change collections, features and role, revoke (409 `LAST_MASTER`, `OWNER_PROTECTED`, `ALREADY_INVITED`) |
| `GET /health` | Readiness: catalog loaded, QMD alive, LLM configured |

- **Errors:** one shape, `{ error: { code, message, details? } }`. Stable codes: `TOPIC_NOT_FOUND`, `INDEX_MISSING`, `SEARCH_UNAVAILABLE`, `DOCUMENT_NOT_FOUND`, `LLM_NOT_CONFIGURED`, `LLM_INSUFFICIENT_CREDIT`, `DAILY_CAP_REACHED`, `VALIDATION_FAILED`, and for sign-in and permissions `UNAUTHENTICATED` (401), `FORBIDDEN`, `NOT_INVITED`, `CSRF_REJECTED` (403), `LAST_MASTER`, `OWNER_PROTECTED`, `ALREADY_INVITED` (409), `AUTH_UNAVAILABLE` (503), and for access requests `INVALID_CODE`, `REQUEST_EXPIRED` (400), `ALREADY_REQUESTED` (409), `REQUEST_COOLDOWN` (429).
- **Access:** every `/api/v1` route except sign-in needs a session; collection routes answer 404 for a collection the person cannot see, feature and people routes 403 (ADR 0008). No stack traces (CS-08). The web maps each code to the pt-BR copy in `screens.md`.
- **Pagination:** opaque cursor, default 10, max 50 (CS-09).
- **Filters:** filter fields are allowlisted to the facets above (CS-10).
- **Document ids:** the vault-relative path, URL-encoded. The API rejects any id that resolves outside the topic folder.

## Threat model (CS-17), local R1

1. **What are we building?** A local API that reads a folder, spawns QMD and calls a paid API.
2. **What can go wrong?**
   - Path traversal through a document id, reading `~/.ssh`.
   - Another site in the browser calls `localhost` and spends AI credit (CSRF/DNS rebinding).
   - The OpenRouter key leaks in logs or to the client.
   - Prompt injection inside a vault document steers the AI answer.
   - Command injection through the query into a spawned process.
3. **What are we doing about it?**
   - Path confinement with `realpath` checks.
   - Bind to `127.0.0.1`, strict CORS to the web origin, `Host` header allowlist, the daily cap checked before every model call of the research agent (CS-19).
   - The key is read only from env, redacted in logs, and never in a response (CS-22).
   - The system prompt treats sources as quoted data; answers render as sanitized markdown, with no HTML or links other than citations.
   - `execFile` with an argument array, never a shell, and the query passed as a single argument.
4. **Did we do a good job?** Tests for traversal ids, the Host and CORS rejection and the cap. Revisit before R2 (auth, hosting).

### Sign-in and permissions (KBC-010, ADR 0008)

1. **What are we building?** Google sign-in for several people, with server sessions and per-person collections and features.
2. **What can go wrong?**
   - A forged or replayed ID token, or one minted for another app (wrong `aud`), opens a session.
   - Another site makes a signed-in browser change state (CSRF) or signs it in as the attacker (login CSRF).
   - A stolen session cookie or a copy of the sessions folder.
   - A guest reaches a collection, a feature, another person's history or keys, or the owner's subscriptions and environment keys.
   - A revoked person keeps working; the last master is removed and nobody can manage access.
   - Brute force on the sign-in route; tokens or emails in the logs.
3. **What are we doing about it?**
   - RS256 signature against Google's JWKS, `aud`, `iss`, `exp`/`iat` (60 s skew, 1 h max age) and `email_verified`; the issuer and keys URL are constants. Each credential opens one session (a replay is refused while it is valid); the keys download times out after 5 s.
   - `SameSite=Lax` plus the `X-Requested-With: kb-chat` header and the `Origin` check on every state change, sign-in included.
   - `HttpOnly` cookie (`Secure` when hosted); only the token's SHA-256 is stored, in 0600 files; sliding 30-day expiry.
   - One guard driven by `config.access` on every route (404 for unseen collections, 403 for features and roles), conversations and settings keyed by principal (saving over another person's id answers 404), subscriptions and environment keys for the owner only; the owner sees spend per person, not content.
   - Revocation deletes the sessions at once; `LAST_MASTER` and `OWNER_PROTECTED` keep a master in place.
   - `config.rateLimit` on sign-in; the log carries the person id, never the token or the email.
4. **Did we do a good job?** Tests: token verification with a local key and a fake JWKS (no network), the guard matrix per route kind, the route-coverage check (NFR-2), revocation, the last master, CSRF and the owner migration (`auth.integration.test.ts`, `route-access.test.ts`); E2E AC-1 to AC-7 at 1440 and 390.

### Access requests and one-time codes (KBC-014, ADR 0011)

1. **What are we building?** Public routes that send codes by email (SMS later), create access requests and open sessions with a code.
2. **What can go wrong?** Account enumeration through answers or timing; guessing a 6-digit code; email or SMS bombing through the send routes; a copy of `codes.json` giving codes back; reusing a Google credential or forging the request ticket; a pending, refused or revoked person getting a session; codes in production logs.
3. **What are we doing about it?** Same 202 body for every account state and delivery after the reply; 5 attempts per code, 10 min, single use, a new code replaces the old; 1/min and 5/h per email or phone, 5/min and 20/h per address, verify routes rate-limited; scrypt with a salt per code and `timingSafeEqual`; HMAC-signed, 15 min, single-use tickets with a boot-time key; sessions only for people in `people.json`, checked again at verify time; the API refuses to start in production without Resend or with the SMS log adapter.
4. **Did we do a good job?** Tests: `one-time-codes.test.ts`, `send-limits.test.ts`, `request-ticket.test.ts`, `request-rules.test.ts`, `access-requests.integration.test.ts` (enumeration, approval gate, revocation after send, cooldown, permissions), `route-access.test.ts`; E2E `access.spec.ts` at 1440 and 390.

## Operability (CS-21 to CS-25)

- **Config by env:** `RESEND_API_KEY` and `KB_CHAT_EMAIL_FROM` (required with `NODE_ENV=production`), `KB_CHAT_SMS` (`off` | `log`), `GOOGLE_CLIENT_ID` and `KB_CHAT_OWNER_EMAIL` (required; read from the repository root `.env` by `pnpm dev:api`), `AUTH_RATE_LIMIT`, `KB_VAULT` (default `~/dev/personal/hermetismo`), `QMD_BIN`, `KB_BIN`, `OPENROUTER_API_KEY`, `KB_CHAT_MODEL` (default: the vault's `kb.toml` generation model), `KB_CHAT_DAILY_CAP_USD` (default 1), `PORT`, `WEB_ORIGIN`.
- **Hosting (ADR 0010):** production runs as a Docker Compose project on one OCI Always Free VM, Caddy in front. The container sets `HOST=0.0.0.0` and `TRUST_PROXY=uniquelocal`; the MCP turn endpoint refuses non-loopback sockets. Deployment diagram, threat model and runbook: ADR 0010 and `docs/deploy/runbook.md`.
- **Logs:** structured pino to stdout with a correlation id, route, status and latency.
- **Health:** `/health` reports catalog, QMD and LLM status, which the web uses for the "server is down" states.
- **Lifecycle:** on SIGTERM, close QMD and drain streams. QMD restarts with backoff when it dies.
- **Sensitivity point to monitor (QA-08):** search latency p95 per mode, logged per request and summarised in `usage`.

## Fitness functions (QA-14) → backlog

- **Boundaries lint** fails CI on a cross-module or adapter import (QA-15).
- **Contract test** runs kb and QMD JSON fixtures through the adapters (Q5), plus a live smoke against the real vault behind `KB_VAULT`.
- **Latency check** in the skeleton: a script measures p95 for 20 real queries per mode and fails above the thresholds of Q1 and Q2. It starts as a dated warning (QA-16).
- **Path traversal and Host or CORS tests** (threat model).
- **Contrast check** for the three theme token sets (design).
