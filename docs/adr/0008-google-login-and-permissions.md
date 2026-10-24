# 0008 — Google sign-in and per-person permissions

- Status: proposed (2026-10-24)
- Supersedes: [0005](0005-local-first-single-user-auth-seam.md) once implemented (KBC-010)
- Drivers: the owner's requirement (2026-10-24), sharing the app safely, Q-security

## Context

ADR 0005 kept one implicit principal, `owner`, behind a seam, with logins deferred to release 2. The owner now requires sign-in with a Google account, and access to features and collections according to the permissions they grant. The seam is already in place: usage events, the spend ledger, conversations (KBC-008) and settings (KBC-007) are all keyed by principal.

## Decision

**Sign-in**
- Google OpenID Connect (authorization code with PKCE, state and nonce), handled by the API.
- The principal is the Google `sub`, with the verified email. A session is an opaque random id in an httpOnly, Secure (except on `localhost`) and SameSite=Lax cookie. Server-side sessions are stored under `KB_CHAT_STATE_DIR/sessions/`, with a sliding 30-day expiry.
- The OAuth client id and secret come from the environment.

**Who gets in**
- The owner is configured by `KB_CHAT_OWNER_EMAIL` and has every permission.
- Other people get in only when invited by email. The `people` store lives under `KB_CHAT_STATE_DIR/people.json` (0600).

**Permissions**
- Per person:
  - a set of collection slugs;
  - a set of features: `search`, `research`, `collection-builder`, `own-ai-settings`.
- A single Fastify `onRequest` guard reads the route's declared requirement (`config.access = { topicParam?: 'topic', feature?: 'research' }`) and refuses accordingly:
  - 401 without a session;
  - 404 for a collection the person cannot see, so collections are not even confirmed to exist;
  - 403 for a missing feature.
- A test walks every registered route and fails when a route under `/api/v1` (other than auth, health and `me`) declares no access.
- Revocation deletes the person's sessions. Permission checks read the people store, cached for at most 60 s.

**Per-person data:** history, settings, API keys and spend stay per principal; the owner sees spend per person, not content.

## Options considered

1. **Google OIDC in the API with server sessions (chosen).** There is no third-party auth service, and it works locally and hosted.
2. **A hosted auth provider** (Auth0, Clerk or Firebase Auth). It is faster to add more providers, but it brings a dependency and cost, and the local-first data still needs our own permission model.
3. **A reverse proxy with Google auth** (oauth2-proxy, Cloudflare Access). It gives sign-in with no code, but it provides no per-collection or per-feature permissions inside the app.

## Consequences

- Every route gains an access declaration. The web builds its navigation from `GET /api/v1/me`.
- Local development needs a Google OAuth client with a `http://localhost:<port>` redirect. The e2e suite uses a test identity provider (a stub OIDC server) instead of Google.
- Subscriptions (Claude and ChatGPT via their CLIs) are personal: only the owner may use them (KBC-007 BR-6).
