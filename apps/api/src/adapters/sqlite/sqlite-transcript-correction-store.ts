import type { DatabaseSync, SQLOutputValue } from 'node:sqlite';
import {
  correctionKindSchema,
  correctionStateSchema,
  type LearnedSpan,
} from '@kb-chat/contracts';
import type {
  LearningSource,
  LearningSwitch,
  RuleTally,
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

/**
 * The people's corrections that may teach (KBC-113 BR-1), with the nearest spoken word on
 * each side in their segment, as the version they were made on says it.
 */
const SOURCES = `SELECT c.id, c.media_id, m.title, c.transcript_id, c.first_position, c.word_count,
    c.start_ms, c.before, c.after, c.state, c.carried_to, c.author_name, c.created_at,
    (SELECT w.text FROM words w INDEXED BY words_by_segment_position
      WHERE w.transcript_id = c.transcript_id AND w.segment_position = c.segment_position
        AND w.position < c.first_position AND w.text <> ''
      ORDER BY w.position DESC LIMIT 1) AS context_before,
    (SELECT w.text FROM words w INDEXED BY words_by_segment_position
      WHERE w.transcript_id = c.transcript_id AND w.segment_position = c.segment_position
        AND w.position >= c.first_position + c.word_count AND w.text <> ''
      ORDER BY w.position LIMIT 1) AS context_after
  FROM transcript_corrections c JOIN media m ON m.id = c.media_id
  WHERE c.kind = 'correct' AND c.rule_id IS NULL AND c.state <> 'undone'
  ORDER BY c.created_at, c.rowid`;

interface SourceRow {
  readonly source: LearningSource;
  readonly span: string;
  readonly state: string;
  readonly carriedTo: string | null;
}

function toSource(row: Row): SourceRow {
  return {
    source: {
      id: String(row['id']),
      mediaId: String(row['media_id']),
      mediaTitle: String(row['title']),
      startMs: Number(row['start_ms']),
      before: beforeOf(row['before']),
      after: String(row['after']),
      contextBefore: textOrNull(row['context_before']) ?? '',
      contextAfter: textOrNull(row['context_after']) ?? '',
      createdAt: String(row['created_at']),
      authorName: textOrNull(row['author_name']),
    },
    span: `${String(row['transcript_id'])}:${String(row['first_position'])}:${String(row['word_count'])}`,
    state: String(row['state']),
    carriedTo: textOrNull(row['carried_to']),
  };
}

/** Whether a carried correction is still in force at the end of its chain (BR-1). */
function inForce(
  row: SourceRow,
  chain: ReadonlyMap<string, { state: string; carriedTo: string | null }>,
): boolean {
  let state = row.state;
  let next = row.carriedTo;
  const seen = new Set<string>();
  while (state === 'carried' && next !== null && !seen.has(next)) {
    seen.add(next);
    const link = chain.get(next);
    if (!link) return true;
    state = link.state;
    next = link.carriedTo;
  }
  return state !== 'undone';
}

/** A span corrected again counts once: the newest text over the oldest words (BR-1). */
function latestPerSpan(rows: readonly SourceRow[]): LearningSource[] {
  const bySpan = new Map<string, LearningSource>();
  for (const { source, span } of rows) {
    const first = bySpan.get(span);
    bySpan.set(span, first ? { ...source, before: first.before } : source);
  }
  return [...bySpan.values()].filter((source) => source.after.trim() !== '');
}

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
        row.ruleId,
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

  learningSources(): LearningSource[] {
    const rows = this.db.prepare(SOURCES).all().map(toSource);
    const chain = new Map(
      this.db
        .prepare(
          "SELECT id, state, carried_to FROM transcript_corrections WHERE kind = 'carried'",
        )
        .all()
        .map((row) => [
          String(row['id']),
          {
            state: String(row['state']),
            carriedTo: textOrNull(row['carried_to']),
          },
        ]),
    );
    return latestPerSpan(rows.filter((row) => inForce(row, chain)));
  }

  ruleTallies(): ReadonlyMap<string, RuleTally> {
    return new Map(
      this.db
        .prepare(
          `SELECT rule_id, sum(kind = 'correct') AS applied, sum(state = 'undone') AS undone
           FROM transcript_corrections WHERE rule_id IS NOT NULL GROUP BY rule_id`,
        )
        .all()
        .map((row) => [
          String(row['rule_id']),
          {
            applied: Number(row['applied'] ?? 0),
            undone: Number(row['undone'] ?? 0),
          },
        ]),
    );
  }

  learnedOn(
    transcriptId: string,
    segments: { from: number; count: number },
  ): LearnedSpan[] {
    return this.db
      .prepare(
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
    const rows = this.db
      .prepare(
        `SELECT first_position, word_count FROM transcript_corrections
         WHERE transcript_id = ? AND kind = 'carried'`,
      )
      .all(transcriptId);
    for (const row of rows)
      for (let at = 0; at < Number(row['word_count']); at++)
        positions.add(Number(row['first_position']) + at);
    return positions;
  }

  switches(): ReadonlyMap<string, LearningSwitch> {
    return new Map(
      this.db
        .prepare(
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
      this.db
        .prepare('DELETE FROM learning_switches WHERE kind = ? AND key = ?')
        .run(input.kind, input.key);
      return;
    }
    this.db
      .prepare(
        `INSERT INTO learning_switches (kind, key, enabled, author_principal, author_name, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (kind, key) DO UPDATE SET enabled = excluded.enabled,
           author_principal = excluded.author_principal, author_name = excluded.author_name,
           updated_at = excluded.updated_at`,
      )
      .run(
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
