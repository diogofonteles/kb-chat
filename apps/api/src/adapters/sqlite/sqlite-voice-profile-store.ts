import type { DatabaseSync, SQLOutputValue } from 'node:sqlite';
import {
  voiceConsentMethodSchema,
  voiceSubjectSchema,
  VOICE_CONSENT_PURPOSE,
  type VoiceConsentEntry,
} from '@kb-chat/contracts';
import type { JobStatus, LeaseOwner } from '../../ports/media-store.js';
import type {
  NewVoiceProfile,
  PendingSuggestion,
  SealedEvidence,
  StoredNamedVoice,
  StoredVoiceProfile,
  VoiceProfileSource,
  VoiceProfileStorePort,
} from '../../ports/voice-profile-store.js';
import { inTransaction } from './media-database.js';
import { closeLease } from './sqlite-leases.js';

type Row = Record<string, SQLOutputValue>;

const text = (row: Row, column: string): string => String(row[column]);
const nullableText = (row: Row, column: string): string | null =>
  row[column] === null || row[column] === undefined
    ? null
    : String(row[column]);

const PROFILE_COLUMNS = `p.id, p.speaker_id, p.collection, p.model, p.created_at,
  c.speaker_name, c.granted_by, c.granted_on,
  (SELECT count(*) FROM voice_profile_sources s WHERE s.profile_id = p.id) AS source_count,
  (SELECT j.status FROM jobs j WHERE j.voice_profile_id = p.id
     ORDER BY j.created_at DESC, j.rowid DESC LIMIT 1) AS job_status`;
const PROFILES = `SELECT ${PROFILE_COLUMNS} FROM voice_profiles p
  JOIN voice_consents c ON c.id = p.consent_id`;

const toProfile = (row: Row): StoredVoiceProfile => ({
  id: text(row, 'id'),
  speakerId: text(row, 'speaker_id'),
  speakerName: text(row, 'speaker_name'),
  collection: text(row, 'collection'),
  model: nullableText(row, 'model'),
  sourceCount: Number(row['source_count']),
  grantedBy: text(row, 'granted_by'),
  grantedOn: text(row, 'granted_on'),
  createdAt: text(row, 'created_at'),
  jobStatus: nullableText(row, 'job_status') as JobStatus | null,
});

const toEntry = (row: Row): VoiceConsentEntry => ({
  id: text(row, 'id'),
  speakerName: text(row, 'speaker_name'),
  collection: text(row, 'collection'),
  subject: voiceSubjectSchema.parse(row['subject']),
  grantedBy: text(row, 'granted_by'),
  grantedByRole: nullableText(row, 'granted_by_role'),
  grantedOn: text(row, 'granted_on'),
  method: voiceConsentMethodSchema.parse(row['method']),
  purpose: VOICE_CONSENT_PURPOSE,
  textVersion: Number(row['text_version']),
  registeredBy: text(row, 'registered_by'),
  registeredAt: text(row, 'registered_at'),
  evidence: row['evidence_kind'] === 'attachment' ? 'attachment' : 'text',
  revokedAt: nullableText(row, 'revoked_at'),
  revokedBy: nullableText(row, 'revoked_by'),
  suggestions: {
    made: Number(row['suggestions_made']),
    accepted: Number(row['suggestions_accepted']),
    refused: Number(row['suggestions_refused']),
  },
});

/** Consents, profiles and suggestions (KBC-071); the prints are in the vault (ADR 0032). */
export class SqliteVoiceProfileStore implements VoiceProfileStorePort {
  constructor(private readonly db: DatabaseSync) {}

  create(profile: NewVoiceProfile): boolean {
    return inTransaction(this.db, () => {
      const taken = this.db
        .prepare('SELECT 1 FROM voice_profiles WHERE speaker_id = ?')
        .get(profile.speakerId);
      if (taken) return false;
      this.insertConsent(profile);
      this.insertProfile(profile);
      this.queue({
        profileId: profile.profileId,
        jobId: profile.jobId,
        mediaId: profile.jobMediaId,
        now: profile.now,
      });
      return true;
    });
  }

  private insertConsent(profile: NewVoiceProfile): void {
    const { consent } = profile;
    this.db
      .prepare(
        `INSERT INTO voice_consents (id, profile_id, collection, speaker_id, speaker_name,
           subject, granted_by, granted_by_role, granted_on, method, purpose, text_version,
           registered_by, registered_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        profile.consentId,
        profile.profileId,
        profile.collection,
        profile.speakerId,
        profile.speakerName,
        consent.subject,
        consent.grantedBy,
        consent.grantedByRole,
        consent.grantedOn,
        consent.method,
        consent.purpose,
        consent.textVersion,
        profile.registeredBy,
        profile.now.toISOString(),
      );
    this.insertEvidence(profile.consentId, profile.evidence);
  }

  private insertEvidence(consentId: string, evidence: SealedEvidence): void {
    const { kind, fileName, mime, sealed } = evidence;
    this.db
      .prepare(
        `INSERT INTO voice_consent_evidence (consent_id, kind, file_name, mime, sealed)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(consentId, kind, fileName, mime, sealed);
  }

  private insertProfile(profile: NewVoiceProfile): void {
    const at = profile.now.toISOString();
    this.db
      .prepare(
        `INSERT INTO voice_profiles (id, consent_id, speaker_id, collection, created_at,
           updated_at) VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        profile.profileId,
        profile.consentId,
        profile.speakerId,
        profile.collection,
        at,
        at,
      );
    const source = this.db.prepare(
      `INSERT INTO voice_profile_sources (profile_id, diarization_id, voice)
       VALUES (?, ?, ?)`,
    );
    for (const one of profile.sources)
      source.run(profile.profileId, one.diarizationId, one.voice);
  }

  private queue(job: {
    profileId: string;
    jobId: string;
    mediaId: string;
    now: Date;
  }): void {
    const at = job.now.toISOString();
    this.db
      .prepare(
        `INSERT INTO jobs (id, media_id, kind, status, voice_profile_id, created_at,
           updated_at) VALUES (?, ?, 'voice-profile', 'queued', ?, ?, ?)`,
      )
      .run(job.jobId, job.mediaId, job.profileId, at, at);
  }

  get(id: string): StoredVoiceProfile | null {
    const row = this.db.prepare(`${PROFILES} WHERE p.id = ?`).get(id);
    return row ? toProfile(row) : null;
  }

  list(collection: string): StoredVoiceProfile[] {
    return this.db
      .prepare(`${PROFILES} WHERE p.collection = ? ORDER BY c.speaker_name`)
      .all(collection)
      .map(toProfile);
  }

  ids(): string[] {
    return this.db
      .prepare('SELECT id FROM voice_profiles')
      .all()
      .map((row) => text(row, 'id'));
  }

  oldestConsentAt(): string | null {
    const row = this.db
      .prepare('SELECT min(registered_at) AS oldest FROM voice_consents')
      .get();
    return row ? nullableText(row, 'oldest') : null;
  }

  revokedProfileIds(): string[] {
    return this.db
      .prepare(
        'SELECT profile_id FROM voice_consents WHERE revoked_at IS NOT NULL',
      )
      .all()
      .map((row) => text(row, 'profile_id'));
  }

  recalculate(input: { profileId: string; jobId: string; now: Date }): boolean {
    return inTransaction(this.db, () => {
      const active = this.db
        .prepare(
          `SELECT 1 FROM jobs WHERE voice_profile_id = ?
             AND status IN ('queued', 'leased')`,
        )
        .get(input.profileId);
      const [source] = this.sourcesOf(input.profileId);
      if (active || !source) return false;
      this.db
        .prepare(
          'UPDATE voice_profiles SET model = NULL, updated_at = ? WHERE id = ?',
        )
        .run(input.now.toISOString(), input.profileId);
      this.queue({ ...input, mediaId: source.mediaId });
      return true;
    });
  }

  revoke(input: { profileId: string; by: string; now: Date }): boolean {
    return inTransaction(this.db, () => {
      const row = this.db
        .prepare('SELECT consent_id FROM voice_profiles WHERE id = ?')
        .get(input.profileId);
      if (!row) return false;
      this.db
        .prepare(
          'UPDATE voice_consents SET revoked_at = ?, revoked_by = ? WHERE id = ?',
        )
        .run(input.now.toISOString(), input.by, text(row, 'consent_id'));
      // Sources, suggestions and the job go with it (ON DELETE CASCADE).
      this.db
        .prepare('DELETE FROM voice_profiles WHERE id = ?')
        .run(input.profileId);
      return true;
    });
  }

  namedVoices(speakerId: string): StoredNamedVoice[] {
    return this.db
      .prepare(NAMED_VOICES)
      .all(speakerId)
      .map((row) => ({
        diarizationId: text(row, 'diarization_id'),
        voice: Number(row['voice']),
        mediaId: text(row, 'media_id'),
        title: text(row, 'title'),
        topic: text(row, 'topic'),
        speakingMs: Number(row['speaking_ms']),
      }));
  }

  sourcesOf(
    profileId: string,
  ): (VoiceProfileSource & { readonly mediaId: string })[] {
    return this.db
      .prepare(
        `SELECT s.diarization_id, s.voice, d.media_id FROM voice_profile_sources s
         JOIN diarizations d ON d.id = s.diarization_id
         WHERE s.profile_id = ? ORDER BY d.created_at, s.voice`,
      )
      .all(profileId)
      .map((row) => ({
        diarizationId: text(row, 'diarization_id'),
        voice: Number(row['voice']),
        mediaId: text(row, 'media_id'),
      }));
  }

  heldProfile(owner: LeaseOwner): string | null {
    const row = this.db
      .prepare(
        `SELECT voice_profile_id FROM jobs WHERE id = ? AND lease_id = ? AND worker = ?
           AND status = 'leased' AND kind = 'voice-profile'`,
      )
      .get(owner.jobId, owner.leaseId, owner.worker);
    return row ? text(row, 'voice_profile_id') : null;
  }

  completePrint(input: {
    owner: LeaseOwner;
    model: string;
    now: Date;
  }): boolean {
    const at = input.now.toISOString();
    return inTransaction(this.db, () => {
      const profileId = this.heldProfile(input.owner);
      if (!profileId) return false;
      closeLease(this.db, input.owner, { status: 'done', error: null, at });
      this.db
        .prepare(
          'UPDATE voice_profiles SET model = ?, updated_at = ? WHERE id = ?',
        )
        .run(input.model, at, profileId);
      return true;
    });
  }

  profileOfJob(jobId: string): string | null {
    const row = this.db
      .prepare(
        `SELECT voice_profile_id FROM jobs WHERE id = ? AND kind = 'voice-profile'`,
      )
      .get(jobId);
    return row ? text(row, 'voice_profile_id') : null;
  }

  readyProfiles(collection: string): StoredVoiceProfile[] {
    return this.list(collection).filter((profile) => profile.model !== null);
  }

  addSuggestions(input: {
    diarizationId: string;
    suggestions: readonly {
      voice: number;
      profileId: string;
      similarity: number;
    }[];
  }): void {
    inTransaction(this.db, () => {
      for (const one of input.suggestions)
        this.addSuggestion(input.diarizationId, one);
    });
  }

  private addSuggestion(
    diarizationId: string,
    one: { voice: number; profileId: string; similarity: number },
  ): void {
    const added = this.db
      .prepare(
        `INSERT OR IGNORE INTO voice_profile_suggestions
           (diarization_id, voice, profile_id, similarity)
         SELECT ?, ?, id, ? FROM voice_profiles WHERE id = ?`,
      )
      .run(diarizationId, one.voice, one.similarity, one.profileId);
    if (added.changes === 1) this.count('suggestions_made', one.profileId);
  }

  /** Only the three fixed column names reach the SQL (ND-16). */
  private count(
    column: 'suggestions_made' | 'suggestions_accepted' | 'suggestions_refused',
    profileId: string,
  ): void {
    this.db
      .prepare(
        `UPDATE voice_consents SET ${column} = ${column} + 1 WHERE id =
           (SELECT consent_id FROM voice_profiles WHERE id = ?)`,
      )
      .run(profileId);
  }

  pendingSuggestions(diarizationId: string): PendingSuggestion[] {
    return this.db
      .prepare(
        `SELECT s.voice, s.similarity, p.speaker_id, p.collection
         FROM voice_profile_suggestions s
         JOIN voice_profiles p ON p.id = s.profile_id
         WHERE s.diarization_id = ? AND s.status = 'pending' ORDER BY s.voice`,
      )
      .all(diarizationId)
      .map((row) => ({
        voice: Number(row['voice']),
        speakerId: text(row, 'speaker_id'),
        collection: text(row, 'collection'),
        similarity: Number(row['similarity']),
      }));
  }

  decide(input: {
    diarizationId: string;
    voice: number;
    status: 'accepted' | 'refused';
    by: string;
    now: Date;
  }): boolean {
    const { diarizationId, voice, status, by } = input;
    const counter =
      status === 'accepted' ? 'suggestions_accepted' : 'suggestions_refused';
    return inTransaction(this.db, () => {
      const row = this.db
        .prepare(
          `UPDATE voice_profile_suggestions SET status = ?, decided_by = ?, decided_at = ?
           WHERE diarization_id = ? AND voice = ? AND status = 'pending'
           RETURNING profile_id`,
        )
        .get(status, by, input.now.toISOString(), diarizationId, voice);
      if (row) this.count(counter, text(row, 'profile_id'));
      return row !== undefined;
    });
  }

  report(): VoiceConsentEntry[] {
    return this.db
      .prepare(
        `SELECT c.*, e.kind AS evidence_kind FROM voice_consents c
         JOIN voice_consent_evidence e ON e.consent_id = c.id
         ORDER BY c.registered_at DESC, c.rowid DESC`,
      )
      .all()
      .map(toEntry);
  }

  evidence(consentId: string): SealedEvidence | null {
    const row = this.db
      .prepare(
        `SELECT kind, file_name, mime, sealed FROM voice_consent_evidence
         WHERE consent_id = ?`,
      )
      .get(consentId);
    if (!row) return null;
    return {
      kind: row['kind'] === 'attachment' ? 'attachment' : 'text',
      fileName: nullableText(row, 'file_name'),
      mime: nullableText(row, 'mime'),
      sealed: text(row, 'sealed'),
    };
  }
}

/**
 * The voices named as a speaker on each recording's newest separation, its names confirmed
 * (BR-5 of KBC-065), with the speech of the voices joined to them.
 */
const NAMED_VOICES = `
  SELECT l.diarization_id, l.voice, d.media_id, m.title, m.topic,
    (SELECT coalesce(sum(t.end_ms - t.start_ms), 0) FROM media_speaker_turns t
     WHERE t.diarization_id = l.diarization_id AND (t.voice = l.voice OR t.voice IN
       (SELECT x.voice FROM media_voice_labels x
        WHERE x.diarization_id = l.diarization_id AND x.merged_into = l.voice))) AS speaking_ms
  FROM media_voice_labels l
  JOIN diarizations d ON d.id = l.diarization_id
  JOIN media m ON m.id = d.media_id
  WHERE l.speaker_id = ? AND l.merged_into IS NULL AND d.names_pending = 0
    AND d.version = (SELECT max(n.version) FROM diarizations n WHERE n.media_id = d.media_id)
  ORDER BY m.title, l.voice`;
