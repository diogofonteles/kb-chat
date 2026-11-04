import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import {
  MEDIA_COUNT_CAP,
  transcriptConfidenceSchema,
} from '@kb-chat/contracts';
import type {
  AuthorRule,
  AuthorshipTally,
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

/**
 * Whose passage a match is (KBC-068 BR-6). Without `media-tracks` only recordings answer. With
 * it, a recording keeps a segment unless the tracks took all of it: the same rule as the slice
 * (`track-slice.ts`), word by word, so a word in a gap between tracks is never lost; a segment
 * in part inside a track may then repeat, which beats losing it. A track's rows exist only
 * while it is published.
 */
const ONLY_RECORDINGS = 'm.parent_media_id IS NULL';
const LIVE_TRACK = `SELECT 1 FROM media d
  WHERE d.parent_media_id = m.id AND d.status = 'ready' AND d.archived_at IS NULL`;
const inTrack = (midpointMs: string): string =>
  `EXISTS (${LIVE_TRACK} AND ${midpointMs} >= d.parent_start_ms
    AND ${midpointMs} < d.parent_end_ms)`;
const WORDS_OF_SEGMENT = `FROM words w
  WHERE w.transcript_id = s.transcript_id AND w.segment_position = s.position`;
const INSIDE_ONE_TRACK = `EXISTS (${LIVE_TRACK} AND s.start_ms >= d.parent_start_ms
  AND s.end_ms <= d.parent_end_ms)`;
/** The usual answers come first: no tracks at all, or a segment inside one, read no word. */
const NOT_INSIDE_TRACKS = `(NOT EXISTS (${LIVE_TRACK})
  OR (NOT ${INSIDE_ONE_TRACK} AND (
    EXISTS (SELECT 1 ${WORDS_OF_SEGMENT} AND NOT ${inTrack('(w.start_ms + w.end_ms) / 2.0')})
    OR (NOT EXISTS (SELECT 1 ${WORDS_OF_SEGMENT})
      AND NOT ${inTrack('(s.start_ms + s.end_ms) / 2.0')}))))`;
const passagesFor = (tracks: boolean | undefined): string =>
  tracks ? NOT_INSIDE_TRACKS : ONLY_RECORDINGS;

const FROM_MATCHES = `FROM segments_fts f
  JOIN segments s ON s.rowid = f.rowid
  JOIN transcripts t ON t.id = s.transcript_id
  JOIN media m ON m.id = t.media_id`;

/** The most matches in the whole index that are ranked by relevance (NFR-1). */
const RANKED = 10_000;
/** Past RANKED, this many times the limit are read to put normal confidence first. */
const UNRANKED_POOL = 4;

const SELECT_MATCHES = `SELECT m.id AS media_id, m.topic, m.title, ${AUTHOR} AS author,
    highlight(segments_fts, 0, char(2), char(3)) AS marked,
    s.start_ms, s.end_ms, t.confidence, bm25(segments_fts) AS bm25
  ${FROM_MATCHES}`;

/** Normal confidence first (BR-3), then relevance, then the earlier passage. */
const ORDER = `ORDER BY t.confidence = 'low', bm25(segments_fts), s.start_ms`;

const byConfidenceThenRelevance = (
  a: MediaSegmentMatch,
  b: MediaSegmentMatch,
): number =>
  Number(a.confidence === 'low') - Number(b.confidence === 'low') ||
  a.bm25 - b.bm25;

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
    tracks,
    count = true,
  }: MediaSearchQuery): MediaSearchResult {
    if (terms.length === 0 || topics.length === 0)
      return { matches: [], total: 0 };
    const scope = scopeClause(topics, authors);
    const where = `WHERE segments_fts MATCH ? AND ${passagesFor(tracks)} AND ${scope.sql}`;
    const values = [toMatchExpression(terms), ...scope.values];
    const matches = this.top(where, values, limit);
    return { matches, total: count ? this.countWhere(where, values) : 0 };
  }

  /**
   * Each group counted with its own limit: a main author who fills the cap never hides
   * the others' passages (and the reverse).
   */
  tally({
    terms,
    topics,
    mainOf,
    tracks,
  }: Parameters<MediaSearchPort['tally']>[0]): AuthorshipTally {
    if (terms.length === 0 || topics.length === 0)
      return { main: 0, others: 0 };
    const countFor = (kind: 'main' | 'others'): number => {
      const scope = scopeClause(topics, { kind, mainOf });
      const where = `WHERE segments_fts MATCH ? AND ${passagesFor(tracks)} AND ${scope.sql}`;
      return this.countWhere(where, [
        toMatchExpression(terms),
        ...scope.values,
      ]);
    };
    return { main: countFor('main'), others: countFor('others') };
  }

  /** Matching segments, up to MEDIA_COUNT_CAP. */
  private countWhere(where: string, values: readonly SQLInputValue[]): number {
    const counted = this.db
      .prepare(
        `SELECT count(*) AS n FROM (SELECT 1 ${FROM_MATCHES} ${where} LIMIT ?)`,
      )
      .get(...values, MEDIA_COUNT_CAP);
    return Number(counted?.['n'] ?? 0);
  }

  /**
   * The best passages (NFR-1): ranking every match of a word said in a large share of
   * 2,000 h costs more than the budget, and such a word ranks nothing useful. Up to
   * RANKED matches in the whole index, all are ranked; past that, the first matches of the
   * person's collections are taken unranked, normal confidence still first (BR-3).
   */
  private top(
    where: string,
    values: readonly SQLInputValue[],
    limit: number,
  ): MediaSegmentMatch[] {
    const [match] = values;
    const common = Number(
      this.db
        .prepare(
          `SELECT count(*) AS n FROM (SELECT 1 FROM segments_fts
             WHERE segments_fts MATCH ? LIMIT ${RANKED + 1})`,
        )
        .get(match ?? '')?.['n'] ?? 0,
    );
    if (common <= RANKED)
      return this.db
        .prepare(`${SELECT_MATCHES} ${where} ${ORDER} LIMIT ?`)
        .all(...values, limit)
        .map(toMatch);
    return this.db
      .prepare(`${SELECT_MATCHES} ${where} LIMIT ?`)
      .all(...values, limit * UNRANKED_POOL)
      .map(toMatch)
      .sort(byConfidenceThenRelevance)
      .slice(0, limit);
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
