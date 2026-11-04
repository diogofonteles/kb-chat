# 0032 — Voice prints live in sealed files outside `media.db` and the backup; the permission needs a master and an explicit grant

- Status: proposed (KBC-071); **needs human legal review before any real use**
- Amends: [0029](0029-recording-edits-speakers-tracks-and-subjects.md) §3 and §9
- Drivers: LGPD art. 5º, II and art. 11 (a voice print tied to a person is sensitive data); KBC-071 BR-1, BR-2, BR-5; the per-person feature rule (2026-10-28); the owner's instruction that the feature stays off by default

## Context

ADR 0029 §3 put the sealed embedding in a `voice_profiles` row of `media.db`. The daily backup (`deploy/scripts/backup-state.sh`) copies `media.db` with `VACUUM INTO`, so a print revoked today would stay in every backup taken before, and restoring one would bring it back. That contradicts BR-2 (revoking deletes the prints within a minute). ADR 0029 §9 also said "masters by default", but a master has every feature implicitly, so the feature would be on for every master the moment it is deployed.

## Decision

1. **A print is one file**, `<media dir>/voice-prints/<profile id>.sealed` (0600, in a 0700 folder), sealed with AES-256-GCM (ADR 0017) under a key derived for this purpose only, bound to its profile id. Audio files already stay out of the backup, and so does this folder. Revoking removes the file first, then the rows.
2. **Everything else stays in `media.db`**: consents, sealed evidence, profiles without the vector, sources and suggestions. `voice_profiles.consent_id` is `NOT NULL`, so a profile cannot exist without a consent. A revoked consent stays as the record of what was authorised and when; the profile, its sources and its suggestions go.
3. **`media-voice-profiles` needs the master role and an explicit grant** (`MASTER_GRANT_ONLY_FEATURES`). It is the one feature a master does not get implicitly; held by a member it does nothing. The report also needs the owner.
4. **A transcriber gets prints only if marked for it**: new kind `voice-profile`, off on every paired transcriber. The Mac needs the optional `voiceprint` extra (ECAPA, SpeechBrain). With no profile for the job's collection, no vector is computed at all.
5. **Thresholds**: the recipe of KBC-063 (T = 0.4 at the API; margin 0.1 and at least 10 s of speech on the Mac). It is not calibrated: 2 speakers and 3 decisions cannot show a false-positive rate.

## Options considered

1. **Sealed column in `media.db` (ADR 0029).** One store, but backups outlive a revocation; rejected.
2. **Sealed files outside the backup (chosen).** A lost disk loses the prints, which are re-computed from the sources with "Calcular de novo".
3. **Exclude a table from the backup.** `VACUUM INTO` copies everything; it would need a second step that could fail silently.

## Consequences

- Good: revocation is complete at once, and a restored backup cannot bring a print back: at worst it lists a profile whose print is gone, which then asks to be calculated again.
- Good: a file left without a row (after a restore) is removed when the API starts.
- Bad: rows and files are not one transaction; removing the file first means a crash leaves a profile with no print, never a print with no profile.
- Bad: migration 15 rebuilds `jobs`: any migration that rebuilds it later must keep `voice-profile` and `voice_profile_id`.
- Revisit when: the owner's legal review changes retention or the permission; calibration replaces the thresholds.
