# 0022 — Media library: an app-owned SQLite store, a reliable job queue, a capped media worker and progressive streaming

- Status: accepted (2026-10-28)
- Amends: [0010](0010-deploy-oracle-cloud-always-free.md) (one more container and one more volume on the VM)
- Drivers: phase 2 plan v3 (KBC-034 to KBC-040); the owner's decisions of 2026-10-28 (transcribe on the Mac, noisy recordings searchable with a notice, monthly cap of US$ 10, phases in the order pilot → A → B → C → D → E); transcription pilot `docs/research/2026-10-28-transcription-pilot.md`; Q7 (the API never writes to the vault)

## Context

Phase 2 adds an audio and video library: people with permission upload lectures, the app converts them for the browser, transcribes them, plays them with subtitles and finds the minute where an idea is said. Today the app has no database: its state is JSON and JSONL files under `/data/state`, and the vault is read-only, produced by `kb` on the owner's Mac and sent with `sync-vault.sh` (ADR 0010).

Media needs what JSON files do not give well: a catalog of media items, millions of timed words, jobs that survive restarts and crashes, and full-text search with positions. Volume is unknown; the plan uses 500 h and 2,000 h. The pilot (111 tracks, 5.59 h, 2026-10-27/28) measured on the production VM, in a container capped to 1 CPU and 2 GB: 1 h of audio to AAC 64k mono in 45–54 s, to Opus 48k in 65 s, `silencedetect` in 18 s, a 10-minute compilation of 15 cuts in 7.3 s; the app answered HTTP 200 on all 64 checks during the runs. AAC 64k mono takes 29.6 MB per hour: 14.8 GB for 500 h, 59.2 GB for 2,000 h, inside the 100 GB of free block volume.

Lessons from the owner's employer's audio systems (knowledge only, no code reused): a naive queue lost 1.5–4 % of jobs until it got leases, heartbeats, a janitor and a dead-letter list; serving audio by loading the whole file broke playback at 5 s; an empty setting silently turned a feature off.

## Decision

1. **Store.** A new API module `media` owns one SQLite database, `/data/media/media.db` (WAL, `foreign_keys=ON`, one writer: the API; the worker reaches it only through the API), with FTS5 for the transcript index (ADR 0024). Tables: `media` (id, owner principal, collection, authorship, title, kind audio|video, source sha256, sizes, duration, status, confidence, timestamps), `media_files` (rendition, path, bytes, mime), `transcripts` (media id, version, provider, model, parameters, terms version, raw JSON path, created), `segments` and `words` (derived from the raw JSON), `jobs` (below), `terms` (ADR 0023), and per-person `playback` (media id, principal, position ms, completed at) and `media_preferences` (speed, time display) for the player (KBC-041). Schema changes are numbered SQL migrations run at API start; the API refuses to start on a failed migration. The driver (`node:sqlite` or `better-sqlite3`) is chosen in KBC-034 by what the API image's Node supports without flags. The database and files live on a new volume `${KB_CHAT_DATA}/media` mounted at `/data/media`; `backup-state.sh` adds a consistent SQLite snapshot (`.backup`) and the raw transcript JSON, never the media files (they are re-creatable from the originals the uploader keeps, unless the owner later decides to keep originals).
2. **Reliable queue in the same database.** A job has `kind` (transcode, transcribe, …), `status` (queued, leased, done, failed, dead), `attempts`, `lease_until`, `heartbeat_at`, `worker`, `error`. A worker leases one job atomically (`UPDATE … RETURNING` on the oldest queued job of the kinds it runs), heartbeats every 15 s, and finishes or fails it. A janitor in the API returns jobs whose lease expired to `queued`, up to 3 attempts; then `dead`, shown to masters with the error. A permanent error (unsupported file, corrupt audio) goes straight to `failed` with no retry. Jobs are idempotent: a re-run writes a new transcript version or replaces a rendition atomically (temp file and rename).
3. **Media worker container.** `media-worker` runs from the API image with another entrypoint, on the private network, with `cpus: 1`, `mem_limit: 2g`, `ffmpeg` and `ffprobe` by absolute path, a timeout per command, and no `.env` beyond its worker token. It talks to the API over HTTP (`/api/v1/media-worker/*`, worker token, ADR 0023) like a remote worker does, so the VM worker and the Mac worker share one protocol. It runs one job at a time: transcodes, silence detection and, later, cuts and compilations. Speech recognition never runs on the VM (the pilot measured faster-whisper small int8 at RTF 0.55 with wrong terms).
4. **Renditions.** Audio: AAC 64 kbit/s mono, `.m4a` with `+faststart`. Video: H.264 720p (CRF 28, `veryfast`) with AAC 96k, `.mp4` with `+faststart`, plus the audio rendition for transcription. Originals are not kept by default (owner's decision 2026-10-28: only irreplaceable ones, in cold storage, later). A 16 kHz mono FLAC for transcription is produced on demand and deleted after the transcript is stored.
5. **Streaming.** `GET /api/v1/media/{id}/stream?rendition=` serves the file with HTTP Range (206, `Accept-Ranges`, `Content-Range`, `ETag`), never reading it whole, behind the same session and collection checks as documents (404 for a collection the person cannot see). Subtitles are WebVTT generated from the stored words (`/api/v1/media/{id}/subtitles.vtt`). No HLS: progressive files are enough for a few concurrent listeners. Caddy keeps compression off for media types.
6. **Fail fast.** With media enabled (`KB_CHAT_MEDIA=on`), the API refuses to start when `/data/media` is not writable, ffmpeg is missing from the worker image, or the worker token store cannot be sealed (`KB_CHAT_SECRETS_KEY`, ADR 0017). With `KB_CHAT_MEDIA=off` (default until KBC-034 ships) no media route is registered.
7. **Spend.** Media spend (paid transcription, ADR 0023) goes into its own ledger with a **monthly** cap, default US$ 10 (owner's decision 2026-10-28), shown to masters; the per-person daily AI cap is unchanged.

## Options considered

1. **SQLite in the API, queue in the same file, separate capped worker (chosen).** One server, no new infrastructure, transactions across catalog and queue, FTS5 with positions, rebuildable derived tables.
2. **More JSON files.** No transactions, no full-text index with positions, and a queue on files repeats the lost-job problem.
3. **Postgres in a container.** Real concurrency and richer search, but one more service to run, back up and upgrade on a 12 GB VM, for a handful of users.
4. **Work inside the API process.** Simpler, but an ffmpeg run competes with research turns for the 2 OCPUs; the cap on a separate container is what kept the site at 200 during the pilot.
5. **HLS segments.** Adaptive bitrate and many listeners; unnecessary at this scale and doubles the files to store.

## Consequences

- Good: the first app-owned data store with transactions; the vault stays read-only (Q7).
- Good: the same worker protocol serves the VM worker, the owner's Mac and any future machine.
- Bad: SQLite allows one writer; the API serializes writes. Fine for a few users; revisit if uploads and transcript writes contend (p95 of a write > 200 ms).
- Bad: one more container and volume on the VM; the runbook and `deploy.sh` grow.
- Backup: the database snapshot and raw JSON go into the encrypted backup; media files do not (decision to revisit with the owner when originals are discarded by uploaders).
- Revisit when: media passes ~80 GB on disk (move renditions to Cloudflare R2, phase 2 plan), or more than one worker machine transcribes at once.
- Compliance: migration tests on an empty and a seeded database; queue tests for lease expiry, heartbeat, retry limit, dead jobs and idempotent re-runs; a Range test (first byte, middle, suffix, 416); E2E of upload → playback at 1440 and 390 px.
