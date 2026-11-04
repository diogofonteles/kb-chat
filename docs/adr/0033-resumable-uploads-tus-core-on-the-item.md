# 0033 — Resumable uploads: the tus core on the existing item, the file's hash in the browser

- Status: accepted (2026-11-04)
- Amends: [0022](0022-media-library-store-queue-and-streaming.md) (upload limit, `source sha256`)
- Drivers: KBC-035 (FR-1, FR-2, NFR-1, BR-2, BR-3); a broken connection must not cost more than one 8 MB part; the Content-Security-Policy of ADR 0010 has no `wasm-unsafe-eval`

## Decision

1. **Wire protocol: tus 1.0 core, without the creation extension.** `POST …/media` creates the item as before and the item is the tus resource: `HEAD` and `PATCH /api/v1/media/{id}/upload`. Session, CSRF, the `media-upload` feature and the owner check stay on Fastify routes like any other. `PATCH` streams to `uploads/{id}.upload.part`, and a part cut short keeps what arrived. A wrong `Upload-Offset` answers 409, an expired upload 410.
2. **Client: `tus-js-client`, not Uppy.** The backlog named Uppy for the screen, but the panel is our own (T14), so Uppy would only add a store and a plugin system around the same client.
3. **Resuming is found by the server.** A browser cannot reopen a file after a reload: the person chooses it again, the hash identifies it, and `POST …/media/check` answers `resume` with the offset. No fingerprint in `localStorage`, and it works from another device.
4. **The hash is computed in JavaScript (`@noble/hashes`), 1 MiB at a time.** Web Crypto has no streaming, and WebAssembly would loosen the CSP. It is slower than WebAssembly, and a 4 GB file takes tens of seconds; the line shows its progress.
5. **The last byte verifies the announced SHA-256.** Bytes that do not match are thrown away and the upload starts over: a wrong hash would otherwise hide or fake a duplicate.
6. **Expiry counts from the last part**, not from creation: a slow upload is not a stopped one. The janitor of ADR 0022 does the deleting.
7. **`PUT …/file` stays** for tools and tests that send a whole file. It sends no hash of its own, so a file sent to an item created without one is never recognized as repeated; on an item created with one, the whole file must match it (§5).

## Options considered

- `@tus/server`: complete, but it owns the request and the storage, so it would sit beside the module's ports and need a second route for auth; the core is two small routes.
- Own chunk protocol: same size of code, no client to reuse.

## Consequences

- Good: `Caddyfile` only widens the upload route; a 4 GiB file passes as parts of 8 MiB.
- Bad: items uploaded before this version have no hash (originals are not kept), so they are never recognized as repeated.
- Bad: the hash takes CPU from the tab on a phone; a Web Worker is the next step if it hurts.
- Compliance: integration tests of offset, conflict, 410 and hash; E2E of a failed part and of a reload.
