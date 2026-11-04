# 0032 — Voice prints live in sealed files outside `media.db` and the backup; the permission needs a master and an explicit grant

- Status: proposed (KBC-071); **needs human legal review before any real use**
- Amends: [0029](0029-recording-edits-speakers-tracks-and-subjects.md) §3 and §9
- Drivers: LGPD art. 5º, II and art. 11 (a voice print tied to a person is sensitive data); KBC-071 BR-1, BR-2, BR-5; the per-person feature rule (2026-10-28); the owner's instruction that the feature stays off by default

## Context

ADR 0029 §3 put the sealed embedding in a `voice_profiles` row of `media.db`. The daily backup (`deploy/scripts/backup-state.sh`) copies `media.db` with `VACUUM INTO`, so a print revoked today would stay in every backup taken before, and restoring one would bring it back. That contradicts BR-2 (revoking deletes the prints within a minute). ADR 0029 §9 also said "masters by default", but a master has every feature implicitly, so the feature would be on for every master the moment it is deployed.

## Decision

1. **A print is one file**, `<media dir>/voice-prints/<profile id>.sealed` (0600, in a 0700 folder), sealed with AES-256-GCM (ADR 0017) under a key derived for this purpose only, bound to its profile id. Audio files already stay out of the backup, and so does this folder. Revoking removes the file first, then the rows.
2. **Everything else stays in `media.db`**: consents, sealed evidence, profiles without the vector, sources and suggestions. `voice_profiles.consent_id` is `NOT NULL`, so a profile cannot exist without a consent. A revoked consent stays as the record of what was authorised and when; the profile, its sources and its suggestions go.
3. **A revocation is also recorded outside `media.db`**: `<media dir>/voice-revocations.list` (0600), one opaque profile id per line, nothing else about a person or a voice. It is in no backup, so a restore never rolls it back. Revoking appends and syncs the id first, then removes the file, then the rows. When the API starts it revokes again every listed profile the database still has, with the start's date and "lista de revogações" as who revoked, because the list keeps ids only. `recalculate` and a print arriving from a job refuse a listed id, and a new consent is a new profile with a new id.
4. **A lost list stops new prints.** With consents in `media.db` and no list (the disk went with it), earlier revocations are unknown, so creating a profile, recalculating and storing a print answer 409 until the owner has checked the list and marked it as started (runbook §11). Revoking always works.
5. **`media-voice-profiles` needs the master role and an explicit grant** (`MASTER_GRANT_ONLY_FEATURES`). It is the one feature a master does not get implicitly; held by a member it does nothing. The report also needs the owner.
6. **A transcriber gets prints only if marked for it**: new kind `voice-profile`, off on every paired transcriber. The Mac needs the optional `voiceprint` extra (ECAPA, SpeechBrain). With no profile for the job's collection, no vector is computed at all.
7. **A revocation reaches a job in flight.** Each heartbeat names the prints the job holds, and the API answers which of them no longer have a consent. On the Mac every array of a print lives in a `PrintHold`, zeroed by the heartbeat's thread without waiting for the job's. The job's thread sees it at the next batch of 64 windows, so the wait does not depend on the source's length: a `diarize` job drops its comparison and keeps the separation, a `voice-profile` job stops with no upload. Heartbeats are every 15 s. With no answer for 40 s the hold drops itself, by a watcher apart from the heartbeat, because a job that cannot hear about a revocation must not keep a print. A stub with the real constants on a 6 h source measured the print zeroed 15.0 s after the revocation with the API up and 40.3 s with it hung, in the worst phase, with batches of 1 s and 10 s. The batch running at that moment ends on its own: 15 s or 41 s, plus one batch. That is within 1 minute while a batch takes under 19 s, which the real ECAPA has not yet confirmed.
8. **What the 1 minute does not cover is written in the consent** (version 2): a suspended Mac runs nothing, so a print in its memory goes when it wakes.
9. **Thresholds**: the recipe of KBC-063 (T = 0.4 at the API; margin 0.1 and at least 10 s of speech on the Mac). It is not calibrated: 2 speakers and 3 decisions cannot show a false-positive rate.

## Options considered

1. **Sealed column in `media.db` (ADR 0029).** One store, but backups outlive a revocation; rejected.
2. **Sealed files outside the backup (chosen).** A lost disk loses the prints, which are re-computed from the sources with "Calcular de novo".
3. **Exclude a table from the backup.** `VACUUM INTO` copies everything; it would need a second step that could fail silently.

## Consequences

- Good: revocation is complete at once. A restored backup cannot bring back a print, nor a consent revoked after it was taken: the next start revokes it again, before any route answers. The list is what makes this true: without it, the restored row reads "in force" and "Calcular de novo" would queue a new print.
- Good: a print without a row (after a restore) and a write a crash left unfinished are removed when the API starts.
- Bad: rows and files are not one transaction. The list goes first, so a crash at any point leaves a revocation the next start finishes, never a print of someone who revoked.
- Bad: the list is on the same disk as the prints. After a lost disk, a revocation made after the newest backup is known to nobody but the owner, which is why a lost list stops new prints instead of starting empty.
- Bad: a snapshot of the whole disk or of `media/` would roll the list back. None is taken today; one must not be restored without the list that is current.
- Bad: a reapplied revocation shows the date of the start, not the original one.
- Bad: migration 15 rebuilds `jobs`: any migration that rebuilds it later must keep `voice-profile` and `voice_profile_id`.
- Revisit when: the owner's legal review changes retention or the permission; calibration replaces the thresholds.
