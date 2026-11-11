# 0008 — Google sign-in and per-person permissions

- Status: accepted (2026-10-24), implemented by KBC-010
- Amended by: [0016](0016-house-ai-plan-and-access-policy.md) (guests get the app's AI by default; a master assigns it per person)
- Amended by: [0027](0027-masters-act-as-a-person.md) (masters may act as a person, audited)
- Supersedes: [0005](0005-local-first-single-user-auth-seam.md)
- Drivers: the owner's requirement (2026-10-24), sharing the app safely, Q-security

## Context

ADR 0005 kept one implicit principal, `owner`, behind a seam, with logins deferred to release 2. The owner now requires sign-in with a Google account, also for local use on his Mac, and access to features and collections according to the permissions masters grant. The seam was already in place: usage events, the spend ledger, conversations (KBC-008) and settings (KBC-007) are keyed by principal.

## Decision

**Sign-in: Google Identity Services, ID-token flow** (the same flow as the owner's other app)
- The web loads `https://accounts.google.com/gsi/client` (allow it in any Content-Security-Policy), renders the "Entrar com Google" button with the public client id from `GET /api/v1/auth/config`, and POSTs the credential (a Google ID token, a JWT) to `POST /api/v1/auth/google`.
- The API verifies it with Google's keys: `https://www.googleapis.com/oauth2/v3/certs`, fetched on demand and cached for the response's `Cache-Control` max-age (an unknown `kid` refetches at most every 30 s). It checks the RS256 signature, `aud` equal to `GOOGLE_CLIENT_ID`, `iss` in {`accounts.google.com`, `https://accounts.google.com`}, `exp` and `iat` with 60 s of skew (token at most 1 h old) and `email_verified`. Verification uses `jose`; the issuer and keys URL are constants, not configuration.
- No client secret and no redirect: the client id is public. Sign-in attempts are rate-limited (`AUTH_RATE_LIMIT`, default 10 per minute). Each credential opens one session only: the API remembers the hash of every accepted credential until it expires, so a replayed one is refused (the memory resets on restart; the token's 1 h lifetime bounds the rest). The keys download times out after 5 s (`AUTH_UNAVAILABLE`).
- A session is an opaque random 32-byte token in the `kbchat_session` cookie: `HttpOnly`, `SameSite=Lax`, `Path=/`, 30 days, `Secure` except on `localhost`. The server keeps only its SHA-256, one 0600 file per session under `KB_CHAT_STATE_DIR/sessions/`, with a sliding expiry refreshed at most once an hour.
- CSRF: every state-changing `/api/` request must carry `X-Requested-With: kb-chat` (a cross-site form cannot set it, and CORS lets only `WEB_ORIGIN` send it), and a present `Origin` must be `WEB_ORIGIN`. The MCP turns live outside `/api/` and authenticate with their turn token (ADR 0007).

**Who gets in**
- The principal is the Google `sub`, with the verified email. The owner (`KB_CHAT_OWNER_EMAIL`) keeps the principal `owner`, the alias all data written before logins already uses, so the first sign-in loses nothing and no file moves (migration by alias). The alias follows the configured email: pointing `KB_CHAT_OWNER_EMAIL` at another account hands that account the owner's data, keys and subscriptions, so it changes only with the machine's owner.
- A revoked person who is invited again signs in with the same Google account, so the same `sub`: their own history, settings and keys come back. That is intended; the data is theirs, and revoking only ends access.
- The `master` role grants and revokes collections, features and the role itself; there can be several masters. The owner's account is the first master, always present and always a master (`OWNER_PROTECTED`); the last master cannot be demoted or removed (`LAST_MASTER`, checked first).
- Other people get in only when invited by email; the first sign-in matches the invite by verified email and binds the `sub`. People live in `KB_CHAT_STATE_DIR/people.json` (0600, written atomically): `{ id, sub, email, name, picture, role, topics, features, invitedBy, createdAt, lastLoginAt }`.

**Permissions**
- Per person: a set of collection slugs (exact match) and features: `search`, `research`, `collection-builder` (KBC-009), `own-ai-settings`. A new invite gets `search` on no collection; a master has everything.
- A single Fastify `onRequest` guard reads the route's `config.access` (`{ public: true }` or `{ topicParam?: 'topic'; feature?; master?: true }`; `{}` is "signed in") and refuses with 401 without a session, 404 for a collection the person cannot see (so it is not even confirmed to exist; `GET /topics` lists only visible ones), then 403 for a missing feature or role.
- Fitness function: registering an `/api/v1` route without `config.access` throws at boot, and a test walks the route table (public set, collection routes, feature routes).
- Revocation deletes the person's sessions at once; permission reads come from memory, refreshed from `people.json` when older than 60 s.

**Per-person data and AI:** history, settings, keys and spend stay per principal; nobody sees another person's content, and a conversation id that belongs to someone else answers 404, also on save. The owner sees each person's spend today (`GET /api/v1/spend/people`, owner only), never their content. Guests bring their own AI key: the server's environment keys and the subscription runners (Claude, ChatGPT; KBC-007 BR-6) serve only the owner's principal, and a guest choosing a subscription is refused.

## Options considered

1. **Google Identity Services ID token, verified by the API, with server sessions (chosen).** No secret, no redirect handling, works on `localhost` and hosted, and the session stays revocable on our side.
2. **OIDC authorization code with PKCE in the API** (this ADR's first proposal). Needs a client secret and a callback route for the same result.
3. **A hosted auth provider** (Auth0, Clerk, Firebase Auth). Adds a dependency and cost; the local-first permission model is still ours.
4. **A reverse proxy with Google auth** (oauth2-proxy, Cloudflare Access). No per-collection or per-feature permissions inside the app.

## Consequences

- Every route declares its access; the web builds its navigation from `GET /api/v1/me` and returns to the login screen on any 401 (a full page reload, so no per-person state survives a sign-out).
- The API refuses to start without `GOOGLE_CLIENT_ID` and `KB_CHAT_OWNER_EMAIL`; `pnpm dev:api` reads them from the repository root `.env` (`--env-file-if-exists`).
- Google accepts the button only on the client's authorized JavaScript origins (for local use, `http://localhost:4200`).
- Release 1 runs locally: `trustProxy` stays off. Hosting behind a proxy or tunnel must turn it on (rate limit per client, `Secure` from the forwarded host) in the hosting work.
- Expired session files are deleted when presented; a sweep of abandoned ones is left to the hosting work (a few small files per person locally).
- The E2E server signs its own test ID tokens and serves their JWKS under `/api/e2e/*`; the production composition cannot use it (`main` builds only the Google verifier, and a test checks it).
