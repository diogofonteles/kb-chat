import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import {
  MEDIA_COUNT_CAP,
  transcriptConfidenceSchema,
} from '@kb-chat/contracts';
import type {
  AuthorRule,
  MediaSearchPort,
  MediaSearchQuery,
  MediaSearchResult,
  MediaSegmentMatch,
} from '../../ports/media-search.js';

/** A WHERE fragment with its placeholders' values, in order. */
interface Clause {
  readonly sql: string;
  readonly values: readonly SQLInputValue[];
}

/** The media's author as ADR 0030 §4 reads it (rows the previous image wrote fill only `authorship`). */
const AUTHOR = `COALESCE(m.author, CASE WHEN m.authorship = 'mestre-laercio'
  THEN 'mestre-laercio' END)`;

const placeholders = (count: number): string =>
  Array.from({ length: count }, () => '?').join(', ');

/** Each term quoted: FTS5 operators typed by the person are never read as syntax. */
export const toMatchExpression = (terms: readonly string[]): string =>
  terms.map((term) => `"${term}"`).join(' ');

/** The collections, and per collection who the passage must be by. */
function scopeClause(topics: readonly string[], authors: AuthorRule): Clause {
  if (authors.kind === 'any')
    return {
      sql: `m.topic IN (${placeholders(topics.length)})`,
      values: topics,
    };
  const parts = topics.map((topic) => {
    const main = authors.mainOf.get(topic) ?? null;
    if (authors.kind === 'main')
      return main === null
        ? { sql: '0', values: [] }
        : { sql: `(m.topic = ? AND ${AUTHOR} = ?)`, values: [topic, main] };
    return main === null
      ? { sql: '(m.topic = ?)', values: [topic] }
      : {
          sql: `(m.topic = ? AND (${AUTHOR} IS NULL OR ${AUTHOR} <> ?))`,
          values: [topic, main],
        };
  });
  return {
    sql: `(${parts.map((part) => part.sql).join(' OR ')})`,
    values: parts.flatMap((part) => part.values),
  };
}

const FROM_MATCHES = `FROM segments_fts f
  JOIN segments s ON s.rowid = f.rowid
  JOIN transcripts t ON t.id = s.transcript_id
  JOIN media m ON m.id = t.media_id`;

function toMatch(row: Record<string, unknown>): MediaSegmentMatch {
  return {
    mediaId: String(row['media_id']),
    topic: String(row['topic']),
    title: String(row['title']),
    author: row['author'] === null ? null : String(row['author']),
    marked: String(row['marked']),
    startMs: Number(row['start_ms']),
    endMs: Number(row['end_ms']),
    confidence: transcriptConfidenceSchema.parse(row['confidence']),
    bm25: Number(row['bm25']),
  };
}

/** The current transcripts' segments in SQLite FTS5 (ADR 0024 §1, KBC-039). */
export class SqliteMediaSearch implements MediaSearchPort {
  constructor(private readonly db: DatabaseSync) {}

  search({
    terms,
    topics,
    authors,
    limit,
  }: MediaSearchQuery): MediaSearchResult {
    if (terms.length === 0 || topics.length === 0)
      return { matches: [], total: 0 };
    const scope = scopeClause(topics, authors);
    const where = `WHERE segments_fts MATCH ? AND ${scope.sql}`;
    const values = [toMatchExpression(terms), ...scope.values];
    const matches = this.db
      .prepare(
        `SELECT m.id AS media_id, m.topic, m.title, ${AUTHOR} AS author,
           highlight(segments_fts, 0, char(2), char(3)) AS marked,
           s.start_ms, s.end_ms, t.confidence, bm25(segments_fts) AS bm25
         ${FROM_MATCHES} ${where}
         ORDER BY t.confidence = 'low', bm25(segments_fts), s.start_ms
         LIMIT ?`,
      )
      .all(...values, limit)
      .map(toMatch);
    const counted = this.db
      .prepare(
        `SELECT count(*) AS n FROM (SELECT 1 ${FROM_MATCHES} ${where} LIMIT ?)`,
      )
      .get(...values, MEDIA_COUNT_CAP);
    return { matches, total: Number(counted?.['n'] ?? 0) };
  }

  hasTranscripts(topics: readonly string[]): boolean {
    if (topics.length === 0) return false;
    return (
      this.db
        .prepare(
          `SELECT 1 FROM transcripts t JOIN media m ON m.id = t.media_id
           WHERE m.topic IN (${placeholders(topics.length)}) LIMIT 1`,
        )
        .get(...topics) !== undefined
    );
  }
}
