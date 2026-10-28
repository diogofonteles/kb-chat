# 0024 — Media search: transcripts indexed in the app's own SQLite FTS5, merged into search results, outside the kb vault

- Status: accepted (2026-10-28)
- Drivers: phase 2 plan v3 (item A6 → KBC-039; B3 later); Q7 (the API never writes to the vault); Q1 (exact search p95 ≤ 1 s); ADR 0022

## Context

The phase 2 plan said the transcript would become "a document of the library derived from the raw transcript". The vault, however, is produced by `kb` on the owner's Mac and is read-only for the API (Q7, ADR 0010); media uploaded in the browser would only reach it after a manual `kb ingest` and `sync-vault.sh`. The research agent and the exhaustive sweep read through the vault and QMD.

## Decision

1. **Own index.** Current transcripts are indexed in `media.db` with FTS5 (`segments_fts`, `unicode61 remove_diacritics 2`), one row per segment with media id, start and end ms, collection and authorship. Reindexing follows each new current transcript version in the same transaction.
2. **Search.** `POST /api/v1/topics/{topic}/searches` gains a media group: when the person may see media in that collection, the API runs the FTS5 query alongside the existing search and returns up to 5 media hits (`kind: media`, title, the matched segment's text with the highlighted words, `startMs`, `confidence`), each opening the player at `startMs − 2 s`. The existing facets apply where they mean the same (authorship, collection); the document facets that media do not have hide the media group when they are active. The response shape grows additively; older clients ignore the new field.
3. **Authorship and collection.** A media item belongs to one collection (topic) and has `authorship` (`mestre-laercio` or `outros-autores`, ADR 0015), set at upload and editable by masters; collection permissions apply exactly as to documents.
4. **Not in the vault, for now.** The research agent does not see media in phase A. Phase C (KBC items for "pesquisa com IA sobre mídia") adds research tools over this index (the plan → batched reader → answer pattern, with citations in milliseconds), not a copy of transcripts in the vault.

## Options considered

1. **Own FTS5 index (chosen).** Searchable as soon as the transcript is stored, exact times, no change to `kb` or to Q7.
2. **Write a Markdown document per transcript into the vault on the Mac and sync it.** The agent and the sweep would see it at once, but timing is lost in Markdown, uploads would wait for a manual ingest, and the app would depend on the owner's Mac to publish.
3. **Index transcripts in QMD.** Same index as documents, but QMD is fed from the vault and the API must not write its index (Q7).

## Consequences

- Good: a transcript is findable at the exact minute right after it is stored.
- Bad: two indexes to query per search; the media query runs in parallel and its time is logged separately (target p95 ≤ 150 ms at 2,000 h).
- Bad: until phase C the AI research does not use media; the UI does not claim it does.
- Revisit when phase C defines the research tools, or if the owner wants transcripts inside `kb` for other tools.
- Compliance: integration tests of the merged results with permissions (a collection the person cannot see returns no media), accent-insensitive matching, highlight positions, and the low-confidence badge.
