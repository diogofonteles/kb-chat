# 0037 — Learning from transcript corrections: rules with context applied to new versions on the API, learned terms appended to the term list

- Status: accepted (2026-11-09, the owner's decision in conversation: "Automático com contexto")
- Supersedes: [0034](0034-transcript-word-corrections.md) amendment 9 ("no automatic term list") and KBC-093 BR-16
- Amends: [0023](0023-transcription-pull-worker-on-the-owners-mac.md) §3 (the prompt's list also carries learned terms) and §4 (a new version's derived rows are the raw JSON, the post-filter, the carried corrections **and** the learned rules), [0034](0034-transcript-word-corrections.md) §3 (a log row may name the rule that wrote it)
- Drivers: the owner's request (2026-11-09): every corrected word is recorded and learned with its context so the next transcription makes fewer mistakes; a person's single wrong correction must not spread unseen; nothing already transcribed changes by itself; the Mac and Groq paths behave the same

## Context

KBC-093 keeps an append-only log of word corrections (ADR 0034): who, when, the words' texts before, the text after, the position and the time, in force or undone, carried to a newer version or not. A re-transcription carries the corrections of that same recording by time and text. Nothing taught the next recording: a name the transcriber misses ("Tiuako") is corrected again in every recording. The term list (KBC-040) biases Whisper towards names, within a 224-token prompt, as numbered versions that a transcript records.

## Decision

1. **Rules are derived from the log, not stored.** A rule is computed from the corrections in force written by people (kind `correct`, not undone; a carried one counts through its original while the carried row is in force), excluding empty texts, punctuation-only changes and the learning's own rows. Its key is the span `before` (1 to 5 words, no case, no edge punctuation), the `after` text (edge punctuation off) and the context: the nearest non-empty word before and after the span **in the same segment** of the version it was made on (`^`/`$` at the segment's edges). The same `before → after` in 3 or more distinct contexts also gives a rule "in any context". A rule's id is a hash of its key, stable across reads.
2. **Applied on the API, inside the new version's transaction.** When `completeTranscribe` stores a recording's new version (the Mac or Groq), `onTranscript` runs the carry-over (ADR 0034 §6), then the learned rules, then the track cut. Matching: per segment, left to right, longest span first, never overlapping and never on words the carry-over wrote; a span matches when its text equals `before` and at least one stored context side equals its neighbour; a contextual rule wins over a general one; among rules of the same kind with different `after`, the one with more corrections wins and a tie applies none. Each replacement is written as a correction (ADR 0034 §1: same times, the first word gets the text, edge punctuation of the occurrence kept, a leading capital kept) with a log row naming the rule (`rule_id`), the author `system:learning` ("Aprendizado das correções") and one group per rule per version; the revision goes up once. Already stored versions are never touched.
3. **Feedback.** Undoing a learned row is the ordinary undo (ADR 0034 §3) open to anyone with `media-correct` who sees the recording. Each undone learned row counts against its rule; a rule whose undone replacements reach the corrections that back it is off by itself (`auto-off`). Undoing the person's correction removes its support; a rule with none disappears.
4. **Masters switch rules and terms.** A new table `learning_switches (kind rule|term, key, enabled, who, when)`: a master's explicit on/off overrides the automatic state; `null` returns to automatic. Off means not applied to the next version and not sent to the transcriber; nothing transcribed changes.
5. **Learned terms are a part of the term list.** A learned term is the `after` of a correction in force (1 to 3 words, a valid term, KBC-040), with a capital letter or backed by 2 or more corrections, not in the masters' list. The terms table gets `source manual|learned`: a version holds the masters' terms and then the learned ones that fit in what the masters' terms leave of the 224 tokens, most corrected first. A new version written by `system:learning` is created lazily, when the transcriber asks for the list or a Groq job is queued and the learned part that fits changed; so the transcriber protocol, the version a transcript records and the post-filter by version stay as they are. The masters' screen edits only `source = manual`; a save conflicts only when the masters' terms changed since the version the master opened.
6. **Global scope.** One set of rules and learned terms for every collection, like the term list.
7. **Migration 30, expand only:** `transcript_corrections.rule_id` (nullable, indexed), `terms.source` (default `manual`), `learning_switches`. The previous image reads learned rows as ordinary corrections and learned terms as part of the list.

## Options considered

1. **Derived rules applied on the API at the new version (chosen).** One place for both transcription paths, auditable and undoable through the existing log, no transcriber change.
2. **Replacements in the Mac transcriber.** Would put human edits in the raw JSON (against ADR 0023 §4), would not cover Groq and would need a protocol change; rejected.
3. **A stored rules table updated on each correction.** Duplicates the log and must follow every undo, carry and group undo; deriving keeps one source of truth at the cost of computing on read (bounded by NFR-2); rejected.
4. **Suggestions a master accepts (the 2026-11-07 decision).** Replaced by the owner: too slow for the correction volume, and context was not used.

## Consequences

- Good: a correction teaches every next recording; nothing already transcribed changes by itself; every automatic change is visible, attributed and undoable; one wrong correction is stopped by one undo.
- Good: the transcriber's prompt is fed by real corrections without a master's routine.
- Bad: a new version's words depend on the rules at the time it was stored; rebuilding a version from raw must replay its log (as ADR 0034 already says).
- Bad: rules are computed on each new version and on the masters' screen; with many corrections this costs (NFR-1, NFR-2) and may need a cache.
- Bad: term-list versions now also come from the learning; the versions list grows with "Aprendizado das correções" entries.
- Threats: a person with `media-correct` could teach a wrong or offensive replacement to every recording; mitigated by context, the 3-context rule for "any context", auto-off on undo, masters' switches, and the log with authors (the source correction's author is shown in the examples).
- Revisit when: rules per collection are wanted; a rule needs to edit word times; the volume of corrections makes deriving on read slow.
- Compliance: unit tests of deriving and applying rules; integration tests of the new version with rules (Mac and Groq paths through `complete`), undo by a member, auto-off, switches, learned terms within the limit and versions, the T21 save without false conflicts; a failure-injection test of the transaction; migration test.
