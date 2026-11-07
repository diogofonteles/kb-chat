# 0034 — Transcript word corrections: in place on the current version, with a revision and an append-only log, carried to the next version by time and text

- Status: accepted (2026-11-07, the owner's answers in conversation; proposed 2026-11-05, KBC-093), with the amendment below
- Amends: [0023](0023-transcription-pull-worker-on-the-owners-mac.md) §4 (the derived rows are the raw JSON, the post-filter **and** the corrections), [0024](0024-media-search-outside-the-vault.md) §1 (the index also follows a correction), [0029](0029-recording-edits-speakers-tracks-and-subjects.md) §5 (a track's slice follows a correction of its recording)
- Drivers: the owner's request (2026-11-05, board card "Corrigir palavras da transcrição"); search must find a recording by the right word (ADR 0024); every place that shows the text agrees (KBC-038, KBC-045, KBC-092, KBC-068); edits are auditable and undoable (KBC-073 pattern); the per-person feature rule (2026-10-28)

## Context

A transcript is stored per version (`transcripts`, `segments`, `words`; ADR 0023 §4). The raw JSON is the source of truth and the derived rows are rebuilt from it; a re-transcription adds a version and the newest is current. A segment's text is its words joined (`transcript-filter.ts`), and the web places words in that text by `alignWords` (KBC-045). Several things hang on **a version and its word positions**:

- a separation (`diarizations.transcript_id`, `media_word_voices.word_position`, `media_segment_voices.segment_position`);
- the track edit (`media_edits.transcript_version`, which raises "the transcript changed" in the editor) and draft tracks (`first_segment`, `last_segment`);
- the search index (`segments_fts`, rowid = the segment's rowid, current version only);
- the subtitles' ETag (`<transcript id>.f<filter>.s<rules>`) and the web's word cache (`<media>.<version>`);
- published tracks, whose transcript is a slice of the recording's current one (`provider = derived`, `model = <recording transcript id>`), re-cut by `TrackPublisher.afterTranscript` inside the new version's transaction.

A person fixing one wrong word must not invalidate all of that, and the fix must survive a later re-transcription or be reported, never lost silently.

## Decision

1. **A correction edits the current version in place.** It replaces the `text` of 1 to 5 consecutive `words` rows of one segment of a **recording's** current transcript: the first gets the new text (spaces allowed), the others `''`; empty text removes the words from the text. Row count, positions and times never change, so voices, draft tracks and the editor's version stay valid. The segment's `text` is rewritten by replacing the span from the first word's `charStart` to the last word's `charEnd` (server-side `alignWords`); a segment whose words do not align refuses the correction (409 `not-aligned`). Tracks are never corrected directly (409 `track-derived`).
2. **A revision per transcript.** `transcripts.revision INTEGER NOT NULL DEFAULT 0` goes up by one per correction or undo. The transcript and words responses carry it; the subtitles ETag becomes `<id>.r<revision>.f<filter>.s<rules>`; the web keys its caches by version and revision.
3. **An append-only log.** `transcript_corrections` (id, media id, transcript id, version, revision produced, kind `correct|undo|carried`, first word position, count, start ms, end ms, `before` JSON array of the words' texts, `after` text, `reverts` id, state `active|undone|carried|not-carried`, `carried_to` id, author principal and name, created at). Rows are never deleted; they go with the media (cascade) and are in the backup with `media.db`. Undo is a new row that restores `before` only when the words still say `after` (409 `changed-since` otherwise). A master acting as a person is audited by ADR 0027; the row names the effective person.
4. **Optimistic concurrency per word, not per transcript.** The request carries the version (`412` when re-transcribed) and the texts the person saw (`expected`). When the words still say `expected`, the correction applies even if other words changed; when they say something else, `409 word-changed` with the current text and author. A request whose target already says the new text is a no-op (`200`, no row): retries are idempotent.
5. **One transaction propagates everything.** Words, the segment's text, its `segments_fts` row (delete and insert with the same rowid), the revision, the log, and a re-slice (`replaceDerived`) of only the published tracks whose window holds a changed word (KBC-068 midpoint rule). A failure leaves nothing changed.
6. **Carried to the next version by time and text.** When a recording's new version is stored (`completeTranscribe`'s `alongside`, the transaction that also re-slices tracks), each `active` correction of the previous current version is reapplied when the new version has the same number of words whose midpoints fall in the correction's `[start ms, end ms]` and whose text, normalized (lower case, no diacritics, no punctuation), equals its normalized `before`: a `carried` row. Otherwise it becomes `not-carried`, kept with what the new version says there, and the UI lists it. The same rule applies if a later item ever re-derives a version under a new post-filter.
7. **Permission.** A new feature, `media-correct` ("Corrigir transcrição"), granted per person, masters by default; reading the log needs it too. Undoing another person's correction is for masters.

## Options considered

1. **In place with a revision and a log (chosen).** Cheap writes, nothing hanging on a version breaks, history and undo are explicit.
2. **Every correction is a new transcript version** (`provider = corrected`). Uses the existing "newest is current" path and keeps old texts for free, but each fix copies ~20,000 word rows of a 2 h recording, orphans the separation (voices per `transcript_id`), raises "the transcript changed" in the track editor, bumps every track's version and floods the version list; rejected.
3. **An overlay applied at read time** (corrections table only, derived rows untouched). Keeps derived rows pure, but every reader (search, subtitles, words, slicing, AI proposals, offline) must apply it, and the FTS index would hold the wrong text; rejected.
4. **Corrections in the raw JSON.** Breaks "the raw JSON is what the engine said" (ADR 0023 §4) and the WER calibration; rejected.

## Consequences

- Good: a fixed word is searchable, subtitled and highlighted at once, everywhere, with its times; voices and track edits are untouched.
- Good: every change has an author, a before and an after, and can be undone or re-done after a re-transcription.
- Bad: derived rows are no longer a pure function of the raw JSON and the filter: rebuilding a version from raw must replay its log (rule 6). The machine text of a corrected word lives only in the log's `before` and in the raw JSON.
- Bad: a correction spanning two segments, or one that changes word times, is not possible; it waits for a "segment editing" item if ever needed.
- Bad: carry-over by time and text may leave corrections `not-carried` when the model changes its segmentation; they are listed, not lost.
- Threats: a person with `media-correct` could deface a transcript; mitigated by the per-person grant, the log with authors, undo, masters undoing anyone's change, and the ADR 0027 audit when acting as someone. Text is stored and served as text (no HTML), max 80 characters.
- Revisit when: corrections are wanted on the player page or on tracks; word times need editing. (The term list learning from corrections was decided on 2026-11-07: suggestions only, KBC-113.)
- Compliance: integration tests that a correction changes the search result, the subtitles ETag and the affected tracks only, and leaves the version, voices and `transcriptChanged` untouched; a failure-injection test of the transaction; a property test that every active correction ends `carried` or `not-carried` after a new version; migration test of the new column and table.

## Amendment 2026-11-07 (owner's decisions)

Approved as proposed: corrections only on the preparation steps; the `media-correct` feature (masters by default, members undo their own); carry-over by time and text (rule 6); a correction does not change the low-confidence label (ADR 0023 §6). Changed or added:

8. **Correct all occurrences (KBC-093 BR-11 to BR-15).** A batch replaces every chosen occurrence (1 to 5 consecutive words of one segment whose text, ignoring case and edge punctuation, equals the chosen text) in a track's window or the whole recording, at most 200 per request, each keeping its own edge punctuation. It is one transaction and one revision: all or nothing; `412` when re-transcribed; `409 word-changed` naming the positions whose words no longer say what the preview showed; a client key makes a retry idempotent. The log keeps one row per occurrence (rules 3 and 6 unchanged) plus `group_id` (nullable column on `transcript_corrections`, expand-only); undoing a group is one transaction that restores the rows whose words still say `after` and reports the others. Each affected published track is re-sliced once per batch (rule 5), and each affected track document (ADR 0035, KBC-100) is reconciled once.
9. **No automatic term list.** A correction never changes the transcriber's term list (KBC-040). Active, non-empty `after` texts are read from the log as suggestions a master accepts into the list (a new list version) or dismisses (a new dismissal table); KBC-113.
10. **A word click seeks and opens.** On the preparation steps, a click (or Enter on an occurrence in "Procurar palavra") by someone with `media-correct` seeks the step's player to the word's `startMs`, keeping play or pause, and opens the correction panel, as one action; a word with no time opens the panel without seeking. This is client behaviour only; no contract changes.
