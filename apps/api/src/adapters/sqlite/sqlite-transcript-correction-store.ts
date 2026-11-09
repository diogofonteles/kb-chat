import type { DatabaseSync, SQLOutputValue } from 'node:sqlite';
import {
  correctionKindSchema,
  correctionStateSchema,
} from '@kb-chat/contracts';
import type {
  CorrectionPage,
  CorrectionRow,
  CurrentTranscript,
  TranscriptCorrectionStorePort,
  WordText,
} from '../../ports/transcript-correction-store.js';
import type { StoredWord } from '../../ports/transcript-store.js';
import { inTransaction } from './media-database.js';
import { toWord } from './sqlite-transcript-store.js';

type Row = Record<string, SQLOutputValue>;

const textOrNull = (value: SQLOutputValue | undefined): string | null =>
  value === null || value === undefined ? null : String(value);

const numberOrNull = (value: SQLOutputValue | undefined): number | null =>
  value === null || value === undefined ? null : Number(value);

/** The `before` column: a JSON array of the words' texts. */
function beforeOf(value: SQLOutputValue | undefined): string[] {
  const parsed: unknown = JSON.parse(String(value));
  return Array.isArray(parsed) ? parsed.map(String) : [];
}

function toRow(row: Row): CorrectionRow {
  return {
    id: String(row['id']),
    mediaId: String(row['media_id']),
    transcriptId: String(row['transcript_id']),
    version: Number(row['version']),
    revision: Number(row['revision']),
    kind: correctionKindSchema.parse(row['kind']),
    position: Number(row['first_position']),
    count: Number(row['word_count']),
    segment: Number(row['segment_position']),
    startMs: Number(row['start_ms']),
    endMs: Number(row['end_ms']),
    before: beforeOf(row['before']),
    after: String(row['after']),
    reverts: textOrNull(row['reverts']),
    state: correctionStateSchema.parse(row['state']),
    carriedTo: textOrNull(row['carried_to']),
    checkedVersion: numberOrNull(row['checked_version']),
    found: textOrNull(row['found']),
    groupId: textOrNull(row['group_id']),
    authorPrincipal: String(row['author_principal']),
    authorName: textOrNull(row['author_name']),
    createdAt: String(row['created_at']),
  };
}

const WORDS = `SELECT position, segment_position, start_ms, end_ms, text, probability
  FROM words`;

const INSERT = `INSERT INTO transcript_corrections (id, media_id, transcript_id, version,
    revision, kind, first_position, word_count, segment_position, start_ms, end_ms, before,
    after, reverts, state, carried_to, checked_version, found, group_id, author_principal,
    author_name, created_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

/** A correction alone is its own entry; a group's rows are one (FR-13). */
const ENTRY = 'coalesce(group_id, id)';

/** Word corrections in the media database (KBC-093, ADR 0034). */
export class SqliteTranscriptCorrectionStore implements TranscriptCorrectionStorePort {
  constructor(private readonly db: DatabaseSync) {}

  inTransaction<T>(work: () => T): T {
    return inTransaction(this.db, work);
  }

  current(mediaId: string): CurrentTranscript | null {
    return this.newestBelow(mediaId, Number.MAX_SAFE_INTEGER);
  }

  previousOf(mediaId: string, version: number): CurrentTranscript | null {
    return this.newestBelow(mediaId, version);
  }

  private newestBelow(
    mediaId: string,
    version: number,
  ): CurrentTranscript | null {
    const row = this.db
      .prepare(
        `SELECT id, media_id, version, revision FROM transcripts
         WHERE media_id = ? AND version < ? ORDER BY version DESC LIMIT 1`,
      )
      .get(mediaId, version);
    return row
      ? {
          id: String(row['id']),
          mediaId: String(row['media_id']),
          version: Number(row['version']),
          revision: Number(row['revision']),
        }
      : null;
  }

  wordsAt(transcriptId: string, position: number, count: number): StoredWord[] {
    return this.db
      .prepare(
        `${WORDS} WHERE transcript_id = ? AND position >= ? AND position < ?
         ORDER BY position`,
      )
      .all(transcriptId, position, position + count)
      .map(toWord);
  }

  segmentWords(transcriptId: string, segment: number): StoredWord[] {
    return this.db
      .prepare(
        `${WORDS} INDEXED BY words_by_segment_position
         WHERE transcript_id = ? AND segment_position = ? ORDER BY position`,
      )
      .all(transcriptId, segment)
      .map(toWord);
  }

  allWords(transcriptId: string): StoredWord[] {
    return this.db
      .prepare(`${WORDS} WHERE transcript_id = ? ORDER BY position`)
      .all(transcriptId)
      .map(toWord);
  }

  segmentText(transcriptId: string, segment: number): string | null {
    const row = this.db
      .prepare(
        'SELECT text FROM segments WHERE transcript_id = ? AND position = ?',
      )
      .get(transcriptId, segment);
    return row ? String(row['text']) : null;
  }

  writeWords(transcriptId: string, words: readonly WordText[]): void {
    const update = this.db.prepare(
      'UPDATE words SET text = ? WHERE transcript_id = ? AND position = ?',
    );
    for (const word of words)
      update.run(word.text, transcriptId, word.position);
  }

  /** The index row is replaced under the same rowid (ADR 0034 §5). */
  writeSegment(transcriptId: string, segment: number, text: string): void {
    const row = this.db
      .prepare(
        `UPDATE segments SET text = ? WHERE transcript_id = ? AND position = ?
         RETURNING rowid`,
      )
      .get(text, transcriptId, segment);
    if (!row) return;
    const rowid = Number(row['rowid']);
    const indexed = this.db
      .prepare('DELETE FROM segments_fts WHERE rowid = ?')
      .run(rowid);
    if (Number(indexed.changes) === 0) return;
    this.db
      .prepare('INSERT INTO segments_fts (rowid, text) VALUES (?, ?)')
      .run(rowid, text);
  }

  setRevision(transcriptId: string, revision: number): void {
    this.db
      .prepare('UPDATE transcripts SET revision = ? WHERE id = ?')
      .run(revision, transcriptId);
  }

  insert(row: CorrectionRow): void {
    this.db
      .prepare(INSERT)
      .run(
        row.id,
        row.mediaId,
        row.transcriptId,
        row.version,
        row.revision,
        row.kind,
        row.position,
        row.count,
        row.segment,
        row.startMs,
        row.endMs,
        JSON.stringify(row.before),
        row.after,
        row.reverts,
        row.state,
        row.carriedTo,
        row.checkedVersion,
        row.found,
        row.groupId,
        row.authorPrincipal,
        row.authorName,
        row.createdAt,
      );
  }

  markUndone(id: string): void {
    this.db
      .prepare(
        "UPDATE transcript_corrections SET state = 'undone' WHERE id = ?",
      )
      .run(id);
  }

  markCarried(id: string, to: { carriedTo: string; version: number }): void {
    this.db
      .prepare(
        `UPDATE transcript_corrections
         SET state = 'carried', carried_to = ?, checked_version = ? WHERE id = ?`,
      )
      .run(to.carriedTo, to.version, id);
  }

  markNotCarried(id: string, at: { found: string; version: number }): void {
    this.db
      .prepare(
        `UPDATE transcript_corrections
         SET state = 'not-carried', found = ?, checked_version = ? WHERE id = ?`,
      )
      .run(at.found, at.version, id);
  }

  row(mediaId: string, id: string): CorrectionRow | null {
    const row = this.db
      .prepare(
        'SELECT * FROM transcript_corrections WHERE media_id = ? AND id = ?',
      )
      .get(mediaId, id);
    return row ? toRow(row) : null;
  }

  groupRows(mediaId: string, groupId: string): CorrectionRow[] {
    return this.db
      .prepare(
        `SELECT * FROM transcript_corrections WHERE media_id = ? AND group_id = ?
         ORDER BY start_ms, first_position`,
      )
      .all(mediaId, groupId)
      .map(toRow);
  }

  activeOn(transcriptId: string): CorrectionRow[] {
    return this.db
      .prepare(
        `SELECT * FROM transcript_corrections
         WHERE transcript_id = ? AND state = 'active' AND kind IN ('correct', 'carried')
         ORDER BY created_at, rowid`,
      )
      .all(transcriptId)
      .map(toRow);
  }

  lastWriter(
    transcriptId: string,
    span: { position: number; count: number },
  ): CorrectionRow | null {
    const row = this.db
      .prepare(
        `SELECT * FROM transcript_corrections
         WHERE transcript_id = ? AND first_position < ?
           AND first_position + word_count > ?
         ORDER BY created_at DESC, rowid DESC LIMIT 1`,
      )
      .get(transcriptId, span.position + span.count, span.position);
    return row ? toRow(row) : null;
  }

  history(
    mediaId: string,
    page: { offset: number; limit: number },
  ): CorrectionPage {
    const total = this.db
      .prepare(
        `SELECT count(DISTINCT ${ENTRY}) AS n FROM transcript_corrections
         WHERE media_id = ?`,
      )
      .get(mediaId);
    const keys = this.db
      .prepare(
        `SELECT ${ENTRY} AS entry, max(created_at) AS at, max(rowid) AS last
         FROM transcript_corrections WHERE media_id = ?
         GROUP BY entry ORDER BY at DESC, last DESC LIMIT ? OFFSET ?`,
      )
      .all(mediaId, page.limit, page.offset)
      .map((row) => String(row['entry']));
    const rowsOf = this.db.prepare(
      `SELECT * FROM transcript_corrections WHERE media_id = ? AND ${ENTRY} = ?
       ORDER BY start_ms, first_position, rowid`,
    );
    return {
      total: Number(total?.['n'] ?? 0),
      entries: keys.map((key) => rowsOf.all(mediaId, key).map(toRow)),
    };
  }

  carryOf(
    mediaId: string,
    version: number,
  ): { carried: number; notCarried: number } {
    const row = this.db
      .prepare(
        `SELECT
           sum(state = 'carried') AS carried,
           sum(state = 'not-carried') AS not_carried
         FROM transcript_corrections WHERE media_id = ? AND checked_version = ?`,
      )
      .get(mediaId, version);
    return {
      carried: Number(row?.['carried'] ?? 0),
      notCarried: Number(row?.['not_carried'] ?? 0),
    };
  }
}
