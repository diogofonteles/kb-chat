import type { DatabaseSync, SQLOutputValue } from 'node:sqlite';
import type {
  NewSpeaker,
  SpeakerMove,
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
    return inTransaction(this.db, () => this.place(speaker));
  }

  labelled(mediaId: string): StoredSpeaker[] {
    return this.db
      .prepare(
        `SELECT DISTINCT speaker.id, speaker.collection, speaker.name, speaker.author_slug
         FROM media_voice_labels label
         JOIN diarizations diarization ON diarization.id = label.diarization_id
         JOIN media_speakers speaker ON speaker.id = label.speaker_id
         WHERE diarization.media_id = ?`,
      )
      .all(mediaId)
      .map(toSpeaker);
  }

  rehome<T>(input: {
    mediaId: string;
    moves: readonly SpeakerMove[];
    alongside: () => T;
  }): T {
    return inTransaction(this.db, () => {
      for (const move of input.moves) this.relabel(input.mediaId, move);
      return input.alongside();
    });
  }

  private relabel(mediaId: string, move: SpeakerMove): void {
    const { speaker } = this.place(move.to);
    this.db
      .prepare(
        `UPDATE media_voice_labels SET speaker_id = ?
         WHERE speaker_id = ? AND diarization_id IN
           (SELECT id FROM diarizations WHERE media_id = ?)`,
      )
      .run(speaker.id, move.from, mediaId);
  }

  private place(speaker: NewSpeaker): {
    speaker: StoredSpeaker;
    created: boolean;
  } {
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
         ORDER BY author_slug IS ? DESC, author_slug IS NULL LIMIT 1`,
      )
      .get(
        speaker.collection,
        speaker.authorSlug,
        speaker.nameKey,
        speaker.authorSlug,
      );
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

  refusedNames(diarizationId: string): number[] {
    return this.db
      .prepare(
        `SELECT voice FROM media_voice_refusals WHERE diarization_id = ?
         ORDER BY voice`,
      )
      .all(diarizationId)
      .map((row) => Number(row['voice']));
  }

  refuseName(input: {
    diarizationId: string;
    voice: number;
    by: string;
    now: Date;
  }): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO media_voice_refusals
           (diarization_id, voice, refused_by, refused_at) VALUES (?, ?, ?, ?)`,
      )
      .run(input.diarizationId, input.voice, input.by, input.now.toISOString());
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
      this.lendName(input);
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

  /** `into` takes the name of `voice` when it has none, marked as not its own. */
  private lendName(input: {
    diarizationId: string;
    voice: number;
    into: number;
  }): void {
    this.db
      .prepare(
        `INSERT INTO media_voice_labels
           (diarization_id, voice, speaker_id, audience, name_from_join)
         SELECT diarization_id, ?, speaker_id, audience, 1 FROM media_voice_labels
           WHERE diarization_id = ? AND voice = ?
             AND (speaker_id IS NOT NULL OR audience = 1)
         ON CONFLICT (diarization_id, voice) DO UPDATE SET
           speaker_id = excluded.speaker_id, audience = excluded.audience,
           name_from_join = 1
           WHERE speaker_id IS NULL AND audience = 0`,
      )
      .run(input.into, input.diarizationId, input.voice);
  }

  split(input: { diarizationId: string; voice: number }): void {
    const { diarizationId, voice } = input;
    inTransaction(this.db, () => {
      this.db
        .prepare(
          `UPDATE media_voice_labels SET merged_into = NULL
           WHERE diarization_id = ? AND voice = ?`,
        )
        .run(diarizationId, voice);
      this.takeBackJoinedNames(diarizationId);
    });
  }

  /**
   * A name that came from a join lasts as long as a voice with a name of its own is still
   * joined there: it takes that voice's name, or goes back to none. The left join keeps one
   * row when no such voice is left, so the columns are set to nothing.
   */
  private takeBackJoinedNames(diarizationId: string): void {
    this.db
      .prepare(
        `UPDATE media_voice_labels AS kept
         SET (speaker_id, audience, name_from_join) = (
           SELECT own.speaker_id, coalesce(own.audience, 0), own.voice IS NOT NULL
           FROM (SELECT 1) LEFT JOIN media_voice_labels own
             ON own.diarization_id = kept.diarization_id AND own.merged_into = kept.voice
               AND own.name_from_join = 0
               AND (own.speaker_id IS NOT NULL OR own.audience = 1)
           ORDER BY own.voice LIMIT 1)
         WHERE kept.diarization_id = ? AND kept.name_from_join = 1`,
      )
      .run(diarizationId);
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
           speaker_id = excluded.speaker_id, audience = excluded.audience,
           name_from_join = 0`,
      )
      .run(
        input.diarizationId,
        input.voice,
        input.speakerId,
        input.audience ? 1 : 0,
      );
  }
}
