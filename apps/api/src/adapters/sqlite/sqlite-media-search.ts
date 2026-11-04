import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import {
  MEDIA_COUNT_CAP,
  transcriptConfidenceSchema,
} from '@kb-chat/contracts';
import type {
  AuthorRule,
  AuthorshipTally,
  LinkedTrack,
  MediaSearchPort,
  MediaSearchQuery,
  MediaSearchResult,
  MediaSegmentMatch,
  SubjectCount,
  TrackDetails,
  TrackLinksPort,
  TrackScope,
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

/** A track someone may be told about: published, not archived (KBC-068 FR-1, BR-5). */
const LIVE_TRACK_ROW = `m.parent_media_id IS NOT NULL AND m.status = 'ready'
  AND m.archived_at IS NULL AND m.kind = 'audio'`;
const IN_IDS = `m.id IN (SELECT value FROM json_each(?))`;

/** The tracks a person may be told about, narrowed to `ids` when given. */
function liveTrackClause(
  topics: readonly string[],
  ids: readonly string[] | undefined,
): Clause {
  const inTopics = `m.topic IN (${placeholders(topics.length)})`;
  return ids === undefined
    ? { sql: `${LIVE_TRACK_ROW} AND ${inTopics}`, values: topics }
    : {
        sql: `${LIVE_TRACK_ROW} AND ${IN_IDS} AND ${inTopics}`,
        values: [JSON.stringify(ids), ...topics],
      };
}

const FROM_MATCHES = `FROM segments_fts f
  JOIN segments s ON s.rowid = f.rowid
  JOIN transcripts t ON t.id = s.transcript_id
  JOIN media m ON m.id = t.media_id`;

/** The most matches in the whole index that are ranked by relevance (NFR-1). */
const RANKED = 10_000;
/** Past RANKED, this many times the limit are read to put normal confidence first. */
const UNRANKED_POOL = 4;

const selectMatches = (rank: string, from: string): string =>
  `SELECT m.id AS media_id, m.topic, m.title, ${AUTHOR} AS author,
    highlight(segments_fts, 0, char(2), char(3)) AS marked,
    s.start_ms, s.end_ms, t.confidence, ${rank} AS bm25
  ${from}`;
const SELECT_MATCHES = selectMatches('bm25(segments_fts)', FROM_MATCHES);
/** bm25 walks a word's whole list once: past RANKED, a track's first passage is its best. */
const UNRANKED_SCORE = '-1';

/** Where each track's transcript sits in the index, in the order of the ids. */
const SEGMENT_RANGES = `SELECT t.media_id, t.id AS transcript_id,
    (SELECT s.rowid FROM segments s WHERE s.transcript_id = t.id
      ORDER BY s.position LIMIT 1) AS first,
    (SELECT s.rowid FROM segments s WHERE s.transcript_id = t.id
      ORDER BY s.position DESC LIMIT 1) AS last
  FROM json_each(?) j JOIN transcripts t ON t.media_id = j.value
  ORDER BY j.key`;

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

function toDetails(row: Record<string, unknown>): TrackDetails {
  const duration = row['duration_ms'];
  const summary = row['summary'];
  return {
    mediaId: String(row['id']),
    topic: String(row['topic']),
    title: String(row['title']),
    author: row['author'] === null ? null : String(row['author']),
    durationMs: duration === null ? null : Number(duration),
    summary: summary === null ? null : String(summary),
    parentTitle: String(row['parent_title']),
  };
}

/** The current transcripts' segments in SQLite FTS5 (ADR 0024 §1, KBC-039). */
export class SqliteMediaSearch implements MediaSearchPort, TrackLinksPort {
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

  /** The matches in the whole index, counted up to RANKED + 1. */
  private matchesInIndex(expression: string): number {
    return Number(
      this.db
        .prepare(
          `SELECT count(*) AS n FROM (SELECT 1 FROM segments_fts
             WHERE segments_fts MATCH ? LIMIT ${RANKED + 1})`,
        )
        .get(expression)?.['n'] ?? 0,
    );
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
    if (this.matchesInIndex(String(match ?? '')) <= RANKED)
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

  linkedTracks({ topics, ids }: TrackScope): LinkedTrack[] {
    if (topics.length === 0) return [];
    const scope = liveTrackClause(topics, ids);
    return this.db
      .prepare(
        `SELECT m.id, m.topic, ${AUTHOR} AS author FROM media m
         WHERE ${scope.sql} AND EXISTS (
           SELECT 1 FROM media_subject_links l
           WHERE l.media_id = m.id AND l.status = 'accepted')
         ORDER BY m.created_at DESC, m.id`,
      )
      .all(...scope.values)
      .map((row) => ({
        mediaId: String(row['id']),
        topic: String(row['topic']),
        author: row['author'] === null ? null : String(row['author']),
      }));
  }

  /**
   * A word of a large share of the speech must not walk its whole list for a few tracks: each
   * track asks only its own stretch of the index (one transcript's rows are written together).
   */
  speakingTracks(terms: readonly string[], ids: readonly string[]): string[] {
    if (terms.length === 0 || ids.length === 0) return [];
    return this.db
      .prepare(
        `SELECT r.media_id FROM (${SEGMENT_RANGES}) r
         WHERE EXISTS (SELECT 1 FROM segments_fts f CROSS JOIN segments s ON s.rowid = f.rowid
           WHERE segments_fts MATCH ? AND f.rowid BETWEEN r.first AND r.last
             AND s.transcript_id = r.transcript_id)`,
      )
      .all(JSON.stringify(ids), toMatchExpression(terms))
      .map((row) => String(row['media_id']));
  }

  bestPassages(
    terms: readonly string[],
    ids: readonly string[],
  ): MediaSegmentMatch[] {
    if (terms.length === 0 || ids.length === 0) return [];
    const expression = toMatchExpression(terms);
    const ranked = this.matchesInIndex(expression) <= RANKED;
    const select = selectMatches(
      ranked ? 'bm25(segments_fts)' : UNRANKED_SCORE,
      FROM_MATCHES.replaceAll('JOIN', 'CROSS JOIN'),
    );
    const best = this.db.prepare(
      `${select} WHERE segments_fts MATCH ? AND f.rowid BETWEEN ? AND ?
         AND s.transcript_id = ? ${ranked ? ORDER : ''} LIMIT 1`,
    );
    const ranges = this.db.prepare(SEGMENT_RANGES).all(JSON.stringify(ids));
    const expression = toMatchExpression(terms);
    return ranges.flatMap((range) => {
      const row = best.get(
        expression,
        Number(range['first']),
        Number(range['last']),
        String(range['transcript_id']),
      );
      return row ? [toMatch(row)] : [];
    });
  }

  saying(terms: readonly string[]): ReadonlySet<string> | null {
    if (terms.length === 0) return new Set();
    const expression = toMatchExpression(terms);
    if (this.matchesInIndex(expression) > RANKED) return null;
    const rows = this.db
      .prepare(
        `SELECT DISTINCT t.media_id FROM segments_fts f
         CROSS JOIN segments s ON s.rowid = f.rowid
         CROSS JOIN transcripts t ON t.id = s.transcript_id
         WHERE segments_fts MATCH ? AND EXISTS (
           SELECT 1 FROM media_subject_links l
           WHERE l.media_id = t.media_id AND l.status = 'accepted')`,
      )
      .all(expression);
    return new Set(rows.map((row) => String(row['media_id'])));
  }

  tracksAbout(terms: readonly string[]): ReadonlySet<string> {
    if (terms.length === 0) return new Set();
    const rows = this.db
      .prepare(
        `SELECT media_id FROM track_about_fts WHERE track_about_fts MATCH ?`,
      )
      .all(toMatchExpression(terms));
    return new Set(rows.map((row) => String(row['media_id'])));
  }

  trackDetails(ids: readonly string[]): TrackDetails[] {
    const rows = this.db
      .prepare(
        `SELECT m.id, m.topic, m.title, ${AUTHOR} AS author, m.duration_ms, a.summary,
           p.title AS parent_title
         FROM media m JOIN media p ON p.id = m.parent_media_id
         LEFT JOIN media_track_subjects a ON a.media_id = m.id
         WHERE ${IN_IDS}`,
      )
      .all(JSON.stringify(ids));
    const found = new Map(rows.map((row) => [String(row['id']), row]));
    return ids.flatMap((id) => {
      const row = found.get(id);
      return row ? [toDetails(row)] : [];
    });
  }

  subjectCounts({
    topics,
    authors,
    ids,
  }: Parameters<TrackLinksPort['subjectCounts']>[0]): SubjectCount[] {
    if (topics.length === 0) return [];
    const live = liveTrackClause(topics, ids);
    const scope = scopeClause(topics, authors);
    return this.db
      .prepare(
        `SELECT l.subject_key, count(*) AS n
         FROM media_subject_links l JOIN media m ON m.id = l.media_id
         WHERE l.status = 'accepted' AND ${live.sql} AND ${scope.sql}
         GROUP BY l.subject_key`,
      )
      .all(...live.values, ...scope.values)
      .map((row) => ({
        key: String(row['subject_key']),
        tracks: Number(row['n']),
      }));
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
