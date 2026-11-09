import type { DatabaseSync, SQLOutputValue, StatementSync } from 'node:sqlite';
import {
  correctionKindSchema,
  correctionStateSchema,
  type LearnedSpan,
} from '@kb-chat/contracts';
import type {
  LearningLogRow,
  LearningSwitch,
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
    ruleId: textOrNull(row['rule_id']),
    authorPrincipal: String(row['author_principal']),
    authorName: textOrNull(row['author_name']),
    createdAt: String(row['created_at']),
  };
}

const WORDS = `SELECT position, segment_position, start_ms, end_ms, text, probability
  FROM words`;

const INSERT = `INSERT INTO transcript_corrections (id, media_id, transcript_id, version,
    revision, kind, first_position, word_count, segment_position, start_ms, end_ms, before,
    after, reverts, state, carried_to, checked_version, found, group_id, rule_id,
    author_principal, author_name, created_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

/** A correction alone is its own entry; a group's rows are one (FR-13). */
const ENTRY = 'coalesce(group_id, id)';

/** A person's correction's nearest spoken word on one side, in its segment, as it read. */
const contextWord = (side: 'before' | 'after') => `
  CASE WHEN c.kind = 'correct' AND c.rule_id IS NULL THEN
    (SELECT w.text FROM words w INDEXED BY words_by_segment_position
      WHERE w.transcript_id = c.transcript_id AND w.segment_position = c.segment_position
        AND ${side === 'before' ? 'w.position < c.first_position' : 'w.position >= c.first_position + c.word_count'}
        AND w.text <> ''
      ORDER BY w.position ${side === 'before' ? 'DESC' : 'ASC'} LIMIT 1)
  END`;

/** The log as the learning reads it (KBC-113): corrections and carried rows, oldest first. */
const LOG = `SELECT c.id, c.media_id, m.title, c.transcript_id, c.kind, c.first_position,
    c.word_count, c.start_ms, c.before, c.after, c.state, c.carried_to, c.rule_id,
    c.author_name, c.created_at,
    ${contextWord('before')} AS context_before,
    ${contextWord('after')} AS context_after
  FROM transcript_corrections c JOIN media m ON m.id = c.media_id
  WHERE c.kind IN ('correct', 'carried')
  ORDER BY c.created_at, c.rowid`;

function toLogRow(row: Row): LearningLogRow {
  return {
    id: String(row['id']),
    mediaId: String(row['media_id']),
    mediaTitle: String(row['title']),
    transcriptId: String(row['transcript_id']),
    kind: correctionKindSchema.parse(row['kind']),
    position: Number(row['first_position']),
    count: Number(row['word_count']),
    startMs: Number(row['start_ms']),
    before: beforeOf(row['before']),
    after: String(row['after']),
    state: correctionStateSchema.parse(row['state']),
    carriedTo: textOrNull(row['carried_to']),
    ruleId: textOrNull(row['rule_id']),
    contextBefore: textOrNull(row['context_before']) ?? '',
    contextAfter: textOrNull(row['context_after']) ?? '',
    createdAt: String(row['created_at']),
    authorName: textOrNull(row['author_name']),
  };
}

/** Word corrections in the media database (KBC-093, ADR 0034). */
export class SqliteTranscriptCorrectionStore implements TranscriptCorrectionStorePort {
  /** Statements prepared once: a new version may write a thousand learned words (NFR-1). */
  private readonly statements = new Map<string, StatementSync>();

  constructor(private readonly db: DatabaseSync) {}

  private prepare(sql: string): StatementSync {
    const known = this.statements.get(sql);
    if (known) return known;
    const statement = this.db.prepare(sql);
    this.statements.set(sql, statement);
    return statement;
  }

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
    const row = this.prepare(
      `SELECT id, media_id, version, revision FROM transcripts
         WHERE media_id = ? AND version < ? ORDER BY version DESC LIMIT 1`,
    ).get(mediaId, version);
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
    return this.prepare(
      `${WORDS} WHERE transcript_id = ? AND position >= ? AND position < ?
         ORDER BY position`,
    )
      .all(transcriptId, position, position + count)
      .map(toWord);
  }

  segmentWords(transcriptId: string, segment: number): StoredWord[] {
    return this.prepare(
      `${WORDS} INDEXED BY words_by_segment_position
         WHERE transcript_id = ? AND segment_position = ? ORDER BY position`,
    )
      .all(transcriptId, segment)
      .map(toWord);
  }

  allWords(transcriptId: string): StoredWord[] {
    return this.prepare(`${WORDS} WHERE transcript_id = ? ORDER BY position`)
      .all(transcriptId)
      .map(toWord);
  }

  segmentText(transcriptId: string, segment: number): string | null {
    const row = this.prepare(
      'SELECT text FROM segments WHERE transcript_id = ? AND position = ?',
    ).get(transcriptId, segment);
    return row ? String(row['text']) : null;
  }

  writeWords(transcriptId: string, words: readonly WordText[]): void {
    const update = this.prepare(
      'UPDATE words SET text = ? WHERE transcript_id = ? AND position = ?',
    );
    for (const word of words)
      update.run(word.text, transcriptId, word.position);
  }

  /** The index row is replaced under the same rowid (ADR 0034 §5). */
  writeSegment(transcriptId: string, segment: number, text: string): void {
    const row = this.prepare(
      `UPDATE segments SET text = ? WHERE transcript_id = ? AND position = ?
         RETURNING rowid`,
    ).get(text, transcriptId, segment);
    if (!row) return;
    const rowid = Number(row['rowid']);
    const indexed = this.prepare(
      'DELETE FROM segments_fts WHERE rowid = ?',
    ).run(rowid);
    if (Number(indexed.changes) === 0) return;
    this.prepare('INSERT INTO segments_fts (rowid, text) VALUES (?, ?)').run(
      rowid,
      text,
    );
  }

  setRevision(transcriptId: string, revision: number): void {
    this.prepare('UPDATE transcripts SET revision = ? WHERE id = ?').run(
      revision,
      transcriptId,
    );
  }

  insert(row: CorrectionRow): void {
    this.prepare(INSERT).run(
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
      row.ruleId,
      row.authorPrincipal,
      row.authorName,
      row.createdAt,
    );
  }

  markUndone(id: string): void {
    this.prepare(
      "UPDATE transcript_corrections SET state = 'undone' WHERE id = ?",
    ).run(id);
  }

  markCarried(id: string, to: { carriedTo: string; version: number }): void {
    this.prepare(
      `UPDATE transcript_corrections
         SET state = 'carried', carried_to = ?, checked_version = ? WHERE id = ?`,
    ).run(to.carriedTo, to.version, id);
  }

  markNotCarried(id: string, at: { found: string; version: number }): void {
    this.prepare(
      `UPDATE transcript_corrections
         SET state = 'not-carried', found = ?, checked_version = ? WHERE id = ?`,
    ).run(at.found, at.version, id);
  }

  row(mediaId: string, id: string): CorrectionRow | null {
    const row = this.prepare(
      'SELECT * FROM transcript_corrections WHERE media_id = ? AND id = ?',
    ).get(mediaId, id);
    return row ? toRow(row) : null;
  }

  groupRows(mediaId: string, groupId: string): CorrectionRow[] {
    return this.prepare(
      `SELECT * FROM transcript_corrections WHERE media_id = ? AND group_id = ?
         ORDER BY start_ms, first_position`,
    )
      .all(mediaId, groupId)
      .map(toRow);
  }

  activeOn(transcriptId: string): CorrectionRow[] {
    return this.prepare(
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
    const row = this.prepare(
      `SELECT * FROM transcript_corrections
         WHERE transcript_id = ? AND first_position < ?
           AND first_position + word_count > ?
         ORDER BY created_at DESC, rowid DESC LIMIT 1`,
    ).get(transcriptId, span.position + span.count, span.position);
    return row ? toRow(row) : null;
  }

  history(
    mediaId: string,
    page: { offset: number; limit: number },
  ): CorrectionPage {
    const total = this.prepare(
      `SELECT count(DISTINCT ${ENTRY}) AS n FROM transcript_corrections
         WHERE media_id = ?`,
    ).get(mediaId);
    const keys = this.prepare(
      `SELECT ${ENTRY} AS entry, max(created_at) AS at, max(rowid) AS last
         FROM transcript_corrections WHERE media_id = ?
         GROUP BY entry ORDER BY at DESC, last DESC LIMIT ? OFFSET ?`,
    )
      .all(mediaId, page.limit, page.offset)
      .map((row) => String(row['entry']));
    const rowsOf = this.prepare(
      `SELECT * FROM transcript_corrections WHERE media_id = ? AND ${ENTRY} = ?
       ORDER BY start_ms, first_position, rowid`,
    );
    return {
      total: Number(total?.['n'] ?? 0),
      entries: keys.map((key) => rowsOf.all(mediaId, key).map(toRow)),
    };
  }

  learningLog(): LearningLogRow[] {
    return this.prepare(LOG).all().map(toLogRow);
  }

  learnedOn(
    transcriptId: string,
    segments: { from: number; count: number },
  ): LearnedSpan[] {
    return this.prepare(
      `SELECT id, first_position, word_count, before FROM transcript_corrections
         WHERE transcript_id = ? AND rule_id IS NOT NULL AND state = 'active'
           AND segment_position >= ? AND segment_position < ?
         ORDER BY first_position`,
    )
      .all(transcriptId, segments.from, segments.from + segments.count)
      .map((row) => ({
        position: Number(row['first_position']),
        count: Number(row['word_count']),
        correctionId: String(row['id']),
        before: beforeOf(row['before'])
          .filter((text) => text !== '')
          .join(' '),
      }));
  }

  carriedPositions(transcriptId: string): ReadonlySet<number> {
    const positions = new Set<number>();
    const rows = this.prepare(
      `SELECT first_position, word_count FROM transcript_corrections
         WHERE transcript_id = ? AND kind = 'carried'`,
    ).all(transcriptId);
    for (const row of rows)
      for (let at = 0; at < Number(row['word_count']); at++)
        positions.add(Number(row['first_position']) + at);
    return positions;
  }

  switches(): ReadonlyMap<string, LearningSwitch> {
    return new Map(
      this.prepare(
        'SELECT kind, key, enabled, author_name, updated_at FROM learning_switches',
      )
        .all()
        .map((row) => [
          `${String(row['kind'])}:${String(row['key'])}`,
          {
            enabled: Number(row['enabled']) === 1,
            authorName: textOrNull(row['author_name']),
            at: String(row['updated_at']),
          },
        ]),
    );
  }

  setSwitch(input: {
    kind: 'rule' | 'term';
    key: string;
    enabled: boolean | null;
    author: { principal: string; name: string | null };
    now: Date;
  }): void {
    if (input.enabled === null) {
      this.prepare(
        'DELETE FROM learning_switches WHERE kind = ? AND key = ?',
      ).run(input.kind, input.key);
      return;
    }
    this.prepare(
      `INSERT INTO learning_switches (kind, key, enabled, author_principal, author_name, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (kind, key) DO UPDATE SET enabled = excluded.enabled,
           author_principal = excluded.author_principal, author_name = excluded.author_name,
           updated_at = excluded.updated_at`,
    ).run(
      input.kind,
      input.key,
      input.enabled ? 1 : 0,
      input.author.principal,
      input.author.name,
      input.now.toISOString(),
    );
  }

  carryOf(
    mediaId: string,
    version: number,
  ): { carried: number; notCarried: number } {
    const row = this.prepare(
      `SELECT
           sum(state = 'carried') AS carried,
           sum(state = 'not-carried') AS not_carried
         FROM transcript_corrections WHERE media_id = ? AND checked_version = ?`,
    ).get(mediaId, version);
    return {
      carried: Number(row?.['carried'] ?? 0),
      notCarried: Number(row?.['not_carried'] ?? 0),
    };
  }
}
