# 0005 — Local-first single user in release 1, with an auth seam for release 2

- Status: superseded by [0008](0008-google-login-and-permissions.md) (2026-10-24); accepted 2026-10-24
- Drivers: Q6 evolvability; decision: local first, invited users with login later

## Context

Release 1 runs on the owner's Mac for one user. Release 2 will host the app for invited users with login and a daily AI limit per person. Hosting needs the vault and the QMD index (about 600 MB) on the server.

## Decision

In R1, the API binds to `127.0.0.1` only. It allowlists the `Host` header and the CORS origin, and has no login. Every route already resolves a `Principal` through `AuthPort`. In R1, `LocalNoAuthAdapter` always returns the owner. The spend ledger and the usage events are keyed by the principal id from day one. R2 swaps the adapter (choice of auth provider and hosting in a new ADR) and turns the daily cap per principal on, with no change to `search`, `documents` or `answers`.

## Options considered

1. **Seam now, auth later (chosen).** No login friction in R1, and the cost of R2 stays contained.
2. **Build login in R1.** It slows the skeleton for a single user.
3. **Ignore R2.** Adding per-user limits later would touch every module.

## Consequences

- Good: a fast R1 and a clear R2 path.
- Bad: an unused abstraction in R1. It is kept to one interface and one adapter.
- Compliance: a test asserts that the server refuses a non-loopback `Host`. Revisit at the start of R2, together with the threat model.
