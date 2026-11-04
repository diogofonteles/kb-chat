import type { DatabaseSync, SQLOutputValue } from 'node:sqlite';
import type {
  NewSpeaker,
  SpeakerStorePort,
  StoredSpeaker,
  StoredVoiceLabel,
  VoiceLabelStorePort,
} from '../../ports/speaker-store.js';
import { inTransaction } from './media-database.js';

type Row = Record<string, SQLOutputValue>;

const nullableText = (value: SQLOutputValue | undefined): string | null =>
  value === null || value === undefined ? null : String(value);

const toSpeaker = (row: Row): StoredSpeaker => ({
  id: String(row['id']),
  collection: String(row['collection']),
  name: String(row['name']),
  authorSlug: nullableText(row['author_slug']),
});

const COLUMNS = 'id, collection, name, author_slug';

/** The speakers of each collection (KBC-065), in the media database. */
export class SqliteSpeakerStore implements SpeakerStorePort {
  constructor(private readonly db: DatabaseSync) {}

  list(collection: string): StoredSpeaker[] {
    return this.db
      .prepare(`SELECT ${COLUMNS} FROM media_speakers WHERE collection = ?`)
      .all(collection)
      .map(toSpeaker);
  }

  get(id: string): StoredSpeaker | null {
    const row = this.db
      .prepare(`SELECT ${COLUMNS} FROM media_speakers WHERE id = ?`)
      .get(id);
    return row ? toSpeaker(row) : null;
  }

  add(speaker: NewSpeaker): { speaker: StoredSpeaker; created: boolean } {
    return inTransaction(this.db, () => {
      const existing = this.sameAs(speaker);
      if (!existing) {
        this.insert(speaker);
        return { speaker, created: true };
      }
      if (existing.authorSlug !== null || speaker.authorSlug === null)
        return { speaker: existing, created: false };
      this.link(existing.id, speaker);
      return {
        speaker: { ...existing, authorSlug: speaker.authorSlug },
        created: false,
      };
    });
  }

  update(change: {
    id: string;
    name: string;
    nameKey: string;
    authorSlug: string | null;
    now: Date;
  }): boolean {
    const { id, name, nameKey, authorSlug, now } = change;
    return inTransaction(this.db, () => {
      if (this.isTaken(id, nameKey, authorSlug)) return false;
      this.db
        .prepare(
          `UPDATE media_speakers SET name = ?, name_key = ?, author_slug = ?, updated_at = ?
           WHERE id = ?`,
        )
        .run(name, nameKey, authorSlug, now.toISOString(), id);
      return true;
    });
  }

  /** Whether another speaker of the same collection has that name or author. */
  private isTaken(
    id: string,
    nameKey: string,
    authorSlug: string | null,
  ): boolean {
    const other = this.db
      .prepare(
        `SELECT 1 FROM media_speakers other
         JOIN media_speakers self ON self.collection = other.collection
         WHERE self.id = ? AND other.id <> self.id
           AND (other.name_key = ? OR other.author_slug = ?)`,
      )
      .get(id, nameKey, authorSlug);
    return other !== undefined;
  }

  /** The speaker that author, or else that name, already is. */
  private sameAs(speaker: NewSpeaker): StoredSpeaker | null {
    const row = this.db
      .prepare(
        `SELECT ${COLUMNS} FROM media_speakers
         WHERE collection = ? AND (author_slug = ? OR name_key = ?)
         ORDER BY author_slug IS NULL LIMIT 1`,
      )
      .get(speaker.collection, speaker.authorSlug, speaker.nameKey);
    return row ? toSpeaker(row) : null;
  }

  private insert(speaker: NewSpeaker): void {
    const at = speaker.now.toISOString();
    this.db
      .prepare(
        `INSERT INTO media_speakers (id, collection, name, name_key, author_slug,
           created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        speaker.id,
        speaker.collection,
        speaker.name,
        speaker.nameKey,
        speaker.authorSlug,
        speaker.createdBy,
        at,
        at,
      );
  }

  private link(id: string, speaker: NewSpeaker): void {
    this.db
      .prepare(
        'UPDATE media_speakers SET author_slug = ?, updated_at = ? WHERE id = ?',
      )
      .run(speaker.authorSlug, speaker.now.toISOString(), id);
  }
}

function toLabel(row: Row): StoredVoiceLabel {
  const mergedInto = row['merged_into'];
  return {
    voice: Number(row['voice']),
    speaker: row['id'] === null ? null : toSpeaker(row),
    audience: row['audience'] === 1,
    mergedInto: mergedInto === null ? null : Number(mergedInto),
  };
}

/** The names of the voices of each separation (KBC-065), in the media database. */
export class SqliteVoiceLabelStore implements VoiceLabelStorePort {
  constructor(private readonly db: DatabaseSync) {}

  labels(diarizationId: string): StoredVoiceLabel[] {
    return this.db
      .prepare(
        `SELECT label.voice, label.audience, label.merged_into,
           speaker.id, speaker.collection, speaker.name, speaker.author_slug
         FROM media_voice_labels label
         LEFT JOIN media_speakers speaker ON speaker.id = label.speaker_id
         WHERE label.diarization_id = ? ORDER BY label.voice`,
      )
      .all(diarizationId)
      .map(toLabel);
  }

  setLabel(input: {
    diarizationId: string;
    voice: number;
    speakerId: string | null;
    audience: boolean;
  }): void {
    this.upsert(input);
  }

  merge(input: { diarizationId: string; voice: number; into: number }): void {
    const { diarizationId, voice, into } = input;
    inTransaction(this.db, () => {
      this.db
        .prepare(
          `INSERT INTO media_voice_labels (diarization_id, voice, speaker_id, audience)
           SELECT diarization_id, ?, speaker_id, audience FROM media_voice_labels
             WHERE diarization_id = ? AND voice = ?
           ON CONFLICT (diarization_id, voice) DO UPDATE SET
             speaker_id = excluded.speaker_id, audience = excluded.audience
             WHERE speaker_id IS NULL AND audience = 0`,
        )
        .run(into, diarizationId, voice);
      this.db
        .prepare(
          `INSERT INTO media_voice_labels (diarization_id, voice, merged_into)
           VALUES (?, ?, ?)
           ON CONFLICT (diarization_id, voice) DO UPDATE SET merged_into = excluded.merged_into`,
        )
        .run(diarizationId, voice, into);
      this.db
        .prepare(
          `UPDATE media_voice_labels SET merged_into = ?
           WHERE diarization_id = ? AND merged_into = ?`,
        )
        .run(into, diarizationId, voice);
    });
  }

  split(input: { diarizationId: string; voice: number }): void {
    this.db
      .prepare(
        `UPDATE media_voice_labels SET merged_into = NULL
         WHERE diarization_id = ? AND voice = ?`,
      )
      .run(input.diarizationId, input.voice);
  }

  confirmNames(diarizationId: string): void {
    this.db
      .prepare('UPDATE diarizations SET names_pending = 0 WHERE id = ?')
      .run(diarizationId);
  }

  private upsert(input: {
    diarizationId: string;
    voice: number;
    speakerId: string | null;
    audience: boolean;
  }): void {
    this.db
      .prepare(
        `INSERT INTO media_voice_labels (diarization_id, voice, speaker_id, audience)
         VALUES (?, ?, ?, ?)
         ON CONFLICT (diarization_id, voice) DO UPDATE SET
           speaker_id = excluded.speaker_id, audience = excluded.audience`,
      )
      .run(
        input.diarizationId,
        input.voice,
        input.speakerId,
        input.audience ? 1 : 0,
      );
  }
}
