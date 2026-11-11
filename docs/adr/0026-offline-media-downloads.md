# 0026 — Offline media downloads: a scoped service worker, resumable chunked downloads in IndexedDB, Range served from the chunks, and server grants that expire

- Status: proposed (2026-10-29)
- Deciders: the owner (Diogo Fonteles)
- Drivers: the owner's request of 2026-10-29 ("salvar pra ouvir offline … isso deve valer para audio e video"); benchmark `docs/research/2026-10-29-media-library-benchmark.md` §1.4 and §4; owner's rule of 2026-10-28 (every feature granted per person or group); media shared only among app users; one Always Free VM (ADR 0010); ADR 0022 (stream with Range, `media.db`), ADR 0025 (one `MediaEngine` over an `HTMLMediaElement`)
- Related: KBC-056, KBC-057, KBC-041 (positions saved locally and resent), KBC-038 (subtitles), KBC-042 (bookmarks)

## Context

People want to keep lectures on the phone and listen with no network (commute, travel, poor signal), for audio and video. The app is an Angular SPA with no service worker today; the API streams renditions with HTTP Range behind the session and collection checks (ADR 0022). Spotify's model is: download a playlist or an item, up to 10,000 items on each of up to 5 devices, go online every 30 days or the downloads stop working.

Quality attribute scenarios:
- **Offline playback.** With the device in airplane mode, a downloaded 2 h audio or 1 h 720p video opens from the app's home in ≤ 3 s and seeking to any minute starts playback in ≤ 500 ms, in Chrome (Android, desktop) and Safari (iPhone, browser and Home Screen app).
- **Resumable download.** A 400 MB video download interrupted at 60 % (tab closed, network lost) resumes without fetching more than 8 MB again.
- **Revocation.** When a person loses the `media-offline` permission, the collection, or the media item is removed, the next time the app is online on that device the copy is deleted within 60 s of the app opening; with no contact for 30 days, the copy stops playing.
- **VM safety.** Downloads never degrade streaming for others: at most 2 concurrent downloads per person, served by the same Range route, no new CPU work on the VM.

Platform constraints (benchmark §4): no Background Fetch in Safari or Firefox; storage is evictable unless persistent; Safari grants an origin up to ~60 % of disk; a service worker must build `206` responses itself when serving media from storage; a browser cannot hide downloaded bytes from the device's owner.

## Decision

1. **A hand-written, media-scoped service worker** (`apps/web/src/sw.ts`, bundled as its own entry, registered only for people with `media-offline` after their first download or when they open "Baixadas"). It does two things only:
   - **App shell offline:** precaches `index.html`, the hashed JS/CSS bundles and fonts of the current build (manifest generated at build time) and serves navigations network-first with the cached shell as fallback. A new build installs in the background and the app shows "Nova versão disponível — Atualizar" (no forced reload while media plays).
   - **Offline media:** intercepts `GET /api/v1/media/{id}/stream` and `/subtitles.vtt`; when the item is fully downloaded on this device and its grant is valid, it answers from IndexedDB (Range → `206` with `Content-Range`, no Range → `200`); otherwise it passes the request to the network untouched (streaming behaves exactly as today).
   - Angular's `@angular/service-worker` is not used: it does not serve Range requests from its cache and would own all routes; a small worker we test end to end is safer.
2. **Storage layout (IndexedDB `kbchat-offline`, versioned schema):** `downloads` (media id, rendition, kind, bytes, chunk count, status `queued|downloading|paused|complete|error|expired`, grant id, grant expiry, ETag, created), `chunks` (media id, rendition, index → Blob of 8 MB), `assets` (subtitles VTT, transcript JSON, bookmarks snapshot, metadata for the list: title, author, duration, collection title), `pending` (positions and bookmarks written offline, replayed in order when online). Cache Storage holds only the app shell.
3. **Download in the page, resumable by chunk.** The page fetches the rendition with `Range: bytes=a-b` in 8 MB chunks, verifies each `206` and the `ETag`, stores each chunk before asking for the next, and keeps going while the page is open (mini-player and navigation keep it alive). Reopening the app resumes from the first missing chunk. A changed `ETag` (re-encoded rendition) restarts the download. Two downloads at a time per device; the rest wait in order.
4. **Server grants.** `POST /api/v1/media/{id}/offline-grants` (body: device id, rendition) checks `media` + `media-offline` + collection access, the device limit (5 per person) and the per-device size cap, and returns a grant with `expiresAt` = now + 30 days. `GET /api/v1/media/offline-grants?device=` returns the person's grants for this device with each status (`active`, `revoked: permission|collection|removed`). The app revalidates on every start online and every 24 h while open; `revoked` deletes the chunks and assets at once; a grant past `expiresAt` with no successful revalidation makes the item show "Conecte-se para continuar ouvindo esta mídia offline" and the service worker refuses to serve it. Grants live in `media.db` (`offline_devices`, `offline_grants`); a revalidation renews `expiresAt`.
5. **Device identity.** A random device id created on first download and kept in IndexedDB; the person names it ("iPhone de Diogo", default from the user agent) and can remove devices in "Baixadas" from any other device (removal revokes its grants). No fingerprinting.
6. **Space.** Before each download, `navigator.storage.estimate()` must leave ≥ 500 MB free after it; the per-device cap defaults to 5 GB (person can lower it; a master can raise it per person). The first download asks `navigator.storage.persist()`; if refused, "Baixadas" says the browser may delete downloads when space is short and, on iPhone, suggests adding the app to the Home Screen. A missing chunk detected at play time turns the item into "Baixe de novo" without breaking playback (the worker falls back to the network when online).
7. **Video.** A video may be downloaded as video (720p, the only rendition) or "só o áudio" (the audio rendition, ADR 0022 §4), chosen in the download dialog with both sizes shown. Subtitles and the transcript are always downloaded with the media.
8. **Sign-out and account loss.** Signing out asks "Apagar as mídias baixadas neste aparelho?" (default yes); a revoked account deletes everything at the next online start. The service worker never caches API JSON other than the assets above.

## Options considered

1. **Own service worker + chunked IndexedDB + server grants (chosen).** Resumable on every browser, Range served exactly, revocable, no change to the VM.
2. **Cache Storage holding the whole file per item.** Simpler serving with `Response.slice`, but `cache.put` needs the whole body: no resume, and a 400 MB video needs the whole file before the first byte is stored (iOS memory pressure).
3. **Background Fetch.** Downloads with the app closed, but Chromium only; would still need option 1 for Safari.
4. **`@angular/service-worker` (ngsw) data groups.** No Range from cache; whole-app ownership of fetch; harder to scope to one permission.
5. **Encrypt chunks with a key from the server.** Hides bytes from casual browsing of storage, but the key must be on the device to play offline; it adds CPU on phones and protects little. Rejected; the threat model below accepts the residual risk.

## Consequences

- Good: offline works the same for audio and video and keeps subtitles, transcript and bookmarks; the VM gains only two tables and two routes.
- Good: the service worker also makes the app shell open offline, which "Baixadas" needs.
- Bad: the first service worker in the app; an update bug could serve a stale shell. Mitigation: versioned precache, network-first navigation, an "Atualizar" banner, a kill switch (`/sw.js` served as a no-op worker that unregisters itself when `KB_CHAT_OFFLINE=off`).
- Bad: downloads only progress while the app is open (no Background Fetch on Safari); the UI says so.
- Bad: bytes on the device are readable by its owner. Accepted by the media policy (shared among app users only); revocation removes the app's copy, not copies made outside it.
- Egress: estimated < 2 % of the 10 TB monthly allowance at the planned scale (benchmark §4).

## Threats (four questions)

| Threat | Mitigation |
|---|---|
| A person who lost access keeps playing offline | Revalidation on start and every 24 h; 30-day hard expiry; service worker refuses expired or revoked grants |
| Another person on a shared computer plays someone's downloads | Downloads are tied to the signed-in principal; on sign-out the app offers to delete them; the worker serves only grants of the principal stored with the session marker in IndexedDB |
| Abuse of downloads to scrape the library | `media-offline` granted per person; 2 concurrent downloads; per-device cap; device limit; grant requests logged with principal and device |
| Poisoned or partial chunk | ETag check per chunk; byte count check at completion; an incomplete item is never served offline |

## Compliance

- Unit tests (Vitest) for the Range parser and partial-response builder over chunk boundaries (first byte, middle, suffix, across two chunks, last byte, 416), with fast-check properties; Stryker ≥ 80 % on the worker's serving logic and the download state machine.
- Integration tests for the grant routes: permission, collection, device limit, size cap, revoke reasons, renewal.
- E2E (Playwright, Google Chrome and WebKit): download audio and video, go offline (`context.setOffline(true)`), reload, play and seek; interrupt a download and resume; revoke the permission and see the copy deleted on the next start.
- Real devices before production (owner): iPhone Safari and Home Screen app, Android Chrome, airplane mode.
- `KB_CHAT_OFFLINE=off` (default until KBC-056 ships) registers no grant route and serves the self-unregistering worker.
