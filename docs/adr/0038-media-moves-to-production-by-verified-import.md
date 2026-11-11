# 0038 — Media moves from the owner's Mac to production by a verified, incremental import; production never transcribes

- Status: accepted (2026-11-11, KBC-116; the owner's decisions relayed by the coordinator)
- Amends: [0010](0010-deploy-oracle-cloud-always-free.md) (a second content path from the Mac, beside the vault sync), [0022](0022-media-library-store-queue-and-streaming.md) (a second writer of `media.db`, only while the API is stopped)
- Keeps: [0032](0032-voice-prints-outside-the-database-and-the-backup.md) (voice prints, the revocation list, consents and profiles never leave the Mac), [0035](0035-tracks-as-kb-documents.md) (track documents still reach production through the vault sync), [0036](0036-access-levels-per-collection.md) (levels and scales are each environment's app state)
- Drivers: the owner's request of 2026-11-11 ("precisamos levar as midias, todas as que ainda nao estao la"); the owner's decisions: migrate what exists, the transcriber stays on localhost, repeatable and incremental (only what changed, never duplicate or delete what production has), people linked by e-mail, a local rehearsal, a backup before and a check after; levels later (production has no scale)

## Context

The owner's local app holds 73 media (11 recordings, 62 tracks) with transcripts, word corrections, learned terms, voice separations and names, tracks, subjects and their audio (189 MB). Production has the media library off and an empty media folder. The owner wants production to hold the same library without transcribing again, now and every time the Mac gains or edits media. Every key in `media.db` is a TEXT UUID or a composite over one, so a row means the same thing in both databases. The transcript index (`segments_fts`) is keyed by the implicit rowid of `segments`, which differs between databases.

## Decision

1. **Package, then import.** On the Mac, `media-transfer-main.ts export` reads `~/.kb-chat-media` and `~/.kb-chat` without writing to them and writes a package: a `VACUUM INTO` copy of `media.db` from a read-only connection, migrated in the copy to the code's schema; the files its rows name (audio, raw transcript and separation JSON); a principal → e-mail map; the collections' authors; a manifest with each file's sha256. `push-media.sh` rsyncs it to `/srv/kb-chat/media-inbox/package/` (only differences after the first time) and runs `import-media.sh` on the VM, which checks every sha256, stops `api` and `media-worker`, runs `dist/media-transfer-main.js import` in a one-off container of the running API image with the package mounted read-only, starts the stack and runs the smoke. A `--dry-run` imports into a snapshot of production's database with the API up and changes nothing.
2. **A recording and its tracks are one unit**, keyed by the recording's id, written in one transaction. A ledger table `media_imports` (migration 32) keeps, per unit, the fingerprint of the source rows and of the rows written. The fingerprint is a sha256 over the unit's content rows (columns from `PRAGMA table_info`, ordered by key) and its files' hashes, without the tables and columns production writes by itself (`jobs`, `media_documents`, `media.level`).
3. **Never delete, never overwrite production's changes.** Absent → inserted. Same source fingerprint → untouched. New source fingerprint while production still matches the ledger → the unit's content rows are replaced; people's rows (progress, bookmarks) and production's level stay. Production changed since the import, a track gone on the Mac, a file at the same path with other content, a media already in production without a ledger row, a missing collection, or work in progress on the Mac → the unit is held, listed with its reason, and nothing of it changes (exit code 3).
4. **Production never transcribes.** Only terminal jobs go, without leases; paired transcribers (tokens), spend, media settings and provider caches stay with their environment.
5. **People by e-mail.** A source principal becomes an e-mail through the Mac's `people.json` (the owner is `owner` on both sides), then production's principal. Personal rows of someone absent in production are skipped and counted; recorded authorship stays as it is.
6. **Levels fail closed.** A media's level is set at its first import and belongs to production afterwards. Production's scale with the same id keeps it; a scale without it gives "Sem nível" (masters only); no scale in production for a media that has a level holds the unit, because there the level would restrict nobody. The import never creates or copies scales.
7. **The schemas must match**: the package's and production's applied migrations have the same versions and names, or the import refuses before any change.
8. **Authors are appended, collections are not created.** A missing author of a collection is added to production's `authors.json` (authors grant nothing); a collection that production does not know (no vault folder with `topic.yaml`, not in `collections.json`) holds its units: the vault sync comes first.

## Options considered

1. **Verified package and per-unit import with a ledger (chosen).** Repeatable, incremental, never destructive, reviewable in a dry-run; costs a ledger table and a stopped API for about a minute.
2. **Copy `media.db` and the folder once.** Simplest for an empty production, but the second run would overwrite whatever production gained (progress, bookmarks, its own edits): rejected by "sem apagar o que a produção já tem".
3. **Pair the production API with the Mac transcriber and re-transcribe.** Rejected by the owner (the transcriber stays on localhost; never transcribe again) and it would lose the corrections and edits.
4. **Write into the live database while the API runs.** SQLite allows it, but the API is the single writer by design and keeps caches; a stop of about a minute is cheaper than proving every cache.
5. **Copy the scales with the media.** Scales also rank people and vault documents; copying them changes production's access model, not just its media. Rejected; revisit if the owner asks.

## Consequences

- Good: the same command moves the first 189 MB and, later, one new recording; a second run changes nothing; the dry-run shows what would happen with the real data.
- Good: voice prints and revocations cannot travel (they are never read); no secret is in the package.
- Bad: while the import runs the API is down (about a minute); the runbook schedules it.
- Bad: a unit edited on both sides is held until someone decides; the import never merges inside a unit.
- Bad: ids of speakers or subjects translated by name stay untranslated inside JSON history columns (`media_track_changes`); only display history is affected.
- Bad: files copied by a run that is rolled back stay on disk with no row pointing to them.
- Rollback to an image before migration 32 is safe: the ledger is a table the older image ignores.
- Compliance: integration tests for each rule (insert, idempotent re-run, only the new unit, replace keeping people's rows, conflict, levels, people, hashes, schema, dry-run, voice prints out, no queued job); a rehearsal over a copy of the Mac's database.
