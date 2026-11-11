import type { DatabaseSync, SQLOutputValue, StatementSync } from 'node:sqlite';
import {
  mediaJobKindSchema,
  transcriptConfidenceSchema,
  type TermVersion,
  type TranscriptionTerms,
} from '@kb-chat/contracts';
import type { LeaseOwner } from '../../ports/media-store.js';
import type {
  DerivedSegment,
  JobLease,
  NewTranscript,
  StoredWord,
  TermParts,
  TranscriptStorePort,
  TranscriptSummary,
} from '../../ports/transcript-store.js';
import { inTransaction } from './media-database.js';
import { closeLease } from './sqlite-leases.js';

type Row = Record<string, SQLOutputValue>;

const text = (row: Row, column: string): string => String(row[column]);
const nullableNumber = (row: Row, column: string): number | null =>
  row[column] === null || row[column] === undefined
    ? null
    : Number(row[column]);
const vadOf = (value: unknown): 'applied' | 'skipped' =>
  value === 'skipped' ? 'skipped' : 'applied';

function toSummary(row: Row): TranscriptSummary {
  return {
    id: text(row, 'id'),
    mediaId: text(row, 'media_id'),
    version: Number(row['version']),
    revision: Number(row['revision']),
    model: text(row, 'model'),
    confidence: transcriptConfidenceSchema.parse(row['confidence']),
    vad: vadOf(row['vad']),
    termsVersion: Number(row['terms_version']),
    rawPath: text(row, 'raw_path'),
    filterVersion: Number(row['filter_version']),
    confidenceVersion: Number(row['confidence_version']),
    wordCount: Number(row['word_count']),
    removedWords: Number(row['removed_words']),
    createdAt: text(row, 'created_at'),
  };
}

function toTermVersion(row: Row): TermVersion {
  return {
    version: Number(row['version']),
    createdAt: text(row, 'created_at'),
    authorName: row['author_name'] === null ? null : text(row, 'author_name'),
    termCount: Number(row['term_count']),
  };
}

const TERM_VERSIONS = `SELECT v.version, v.created_at, v.author_name,
    (SELECT count(*) FROM terms t WHERE t.version = v.version) AS term_count
  FROM term_versions v`;

export const toWord = (row: Row): StoredWord => ({
  position: Number(row['position']),
  segment: Number(row['segment_position']),
  startMs: Number(row['start_ms']),
  endMs: Number(row['end_ms']),
  text: text(row, 'text'),
  probability: nullableNumber(row, 'probability'),
});

/** Transcripts and the term list in the media database (ADR 0022 §1, ADR 0023). */
export class SqliteTranscriptStore implements TranscriptStorePort {
  /** Prepared once: a search checks every track it meets (KBC-101 NFR-3). */
  private versions: StatementSync | null = null;

  constructor(private readonly db: DatabaseSync) {}

  currentTerms(): TranscriptionTerms {
    const row = this.db.prepare('SELECT max(version) AS v FROM terms').get();
    const list = this.termsAt(Number(row?.['v']));
    if (!list) throw new Error('the media database has no term list');
    return list;
  }

  termsAt(version: number): TranscriptionTerms | null {
    const rows = this.db
      .prepare('SELECT term FROM terms WHERE version = ? ORDER BY position')
      .all(version);
    if (rows.length === 0) return null;
    return { version, terms: rows.map((row) => text(row, 'term')) };
  }

  termPartsAt(version: number): TermParts | null {
    const rows = this.db
      .prepare(
        'SELECT term, source FROM terms WHERE version = ? ORDER BY position',
      )
      .all(version);
    if (rows.length === 0) return null;
    const of = (source: string) =>
      rows
        .filter((row) => row['source'] === source)
        .map((row) => text(row, 'term'));
    return { version, manual: of('manual'), learned: of('learned') };
  }

  termVersions(): TermVersion[] {
    return this.db
      .prepare(`${TERM_VERSIONS} ORDER BY v.version DESC`)
      .all()
      .map(toTermVersion);
  }

  termVersion(version: number): TermVersion | null {
    const row = this.db
      .prepare(`${TERM_VERSIONS} WHERE v.version = ?`)
      .get(version);
    return row ? toTermVersion(row) : null;
  }

  saveTerms(input: {
    baseVersion: number;
    terms: readonly string[];
    learned?: readonly string[];
    author: { principal: string; name: string | null };
    now: Date;
  }): boolean {
    return inTransaction(this.db, () => {
      if (this.currentTerms().version !== input.baseVersion) return false;
      const version = input.baseVersion + 1;
      this.db
        .prepare(
          `INSERT INTO term_versions (version, created_at, author_principal, author_name)
           VALUES (?, ?, ?, ?)`,
        )
        .run(
          version,
          input.now.toISOString(),
          input.author.principal,
          input.author.name,
        );
      this.insertTerms(version, input.terms, input.learned ?? []);
      return true;
    });
  }

  /** The masters' terms first, then the learned ones (ADR 0037 §5). */
  private insertTerms(
    version: number,
    manual: readonly string[],
    learned: readonly string[],
  ): void {
    const insert = this.db.prepare(
      'INSERT INTO terms (version, position, term, source) VALUES (?, ?, ?, ?)',
    );
    const rows = [
      ...manual.map((term) => [term, 'manual'] as const),
      ...learned.map((term) => [term, 'learned'] as const),
    ];
    rows.forEach(([term, source], index) =>
      insert.run(version, index + 1, term, source),
    );
  }

  heldJob(owner: LeaseOwner): JobLease | null {
    const row = this.db
      .prepare(
        `SELECT media_id, kind FROM jobs
         WHERE id = ? AND lease_id = ? AND worker = ? AND status = 'leased'`,
      )
      .get(owner.jobId, owner.leaseId, owner.worker);
    return row
      ? {
          mediaId: text(row, 'media_id'),
          kind: mediaJobKindSchema.parse(row['kind']),
        }
      : null;
  }

  completeTranscribe(input: {
    owner: LeaseOwner;
    transcript: NewTranscript;
    now: Date;
    alongside?: () => void;
  }): boolean {
    const at = input.now.toISOString();
    return inTransaction(this.db, () => {
      if (
        !closeLease(this.db, input.owner, { status: 'done', error: null, at })
      )
        return false;
      this.insertTranscript(input.transcript, at);
      input.alongside?.();
      return true;
    });
  }

  /** A track's transcript, always one (KBC-068 BR-4): it replaces the older, index included. */
  replaceDerived(transcript: NewTranscript, now: Date): void {
    inTransaction(this.db, () => {
      this.insertTranscript(transcript, now.toISOString());
      this.db
        .prepare('DELETE FROM transcripts WHERE media_id = ? AND id <> ?')
        .run(transcript.mediaId, transcript.id);
    });
  }

  requestTranscription(input: {
    mediaId: string;
    jobId: string;
    now: Date;
  }): boolean {
    const at = input.now.toISOString();
    return inTransaction(this.db, () => {
      const pending = this.db
        .prepare(
          `SELECT 1 FROM jobs WHERE media_id = ? AND kind = 'transcribe'
             AND status IN ('queued', 'leased')`,
        )
        .get(input.mediaId);
      if (pending) return false;
      this.db
        .prepare(
          `INSERT INTO jobs (id, media_id, kind, status, created_at, updated_at)
           VALUES (?, ?, 'transcribe', 'queued', ?, ?)`,
        )
        .run(input.jobId, input.mediaId, at, at);
      return true;
    });
  }

  transcripts(mediaId: string): TranscriptSummary[] {
    this.versions ??= this.db.prepare(
      `SELECT id, media_id, version, revision, model, confidence, vad, terms_version, raw_path,
          filter_version,
         confidence_version, word_count, removed_words, created_at
       FROM transcripts WHERE media_id = ? ORDER BY version DESC`,
    );
    return this.versions.all(mediaId).map(toSummary);
  }

  segments(transcriptId: string): DerivedSegment[] {
    return this.db
      .prepare(
        `SELECT start_ms, end_ms, text, avg_logprob, compression_ratio, no_speech_prob
         FROM segments WHERE transcript_id = ? ORDER BY position`,
      )
      .all(transcriptId)
      .map((row) => ({
        startMs: Number(row['start_ms']),
        endMs: Number(row['end_ms']),
        text: text(row, 'text'),
        avgLogprob: nullableNumber(row, 'avg_logprob'),
        compressionRatio: nullableNumber(row, 'compression_ratio'),
        noSpeechProb: nullableNumber(row, 'no_speech_prob'),
      }));
  }

  words(transcriptId: string): StoredWord[] {
    return this.db
      .prepare(
        `SELECT position, segment_position, start_ms, end_ms, text, probability
         FROM words WHERE transcript_id = ? ORDER BY position`,
      )
      .all(transcriptId)
      .map(toWord);
  }

  wordsOfSegments(
    transcriptId: string,
    range: { readonly from: number; readonly count: number },
  ): StoredWord[] {
    return this.db
      .prepare(
        `SELECT position, segment_position, start_ms, end_ms, text, probability
         FROM words INDEXED BY words_by_segment_position
         WHERE transcript_id = ? AND segment_position >= ? AND segment_position < ?
         ORDER BY segment_position, position`,
      )
      .all(transcriptId, range.from, range.from + range.count)
      .map(toWord);
  }

  /** The newest version of the item gets the next number (BR-3: the newest is current). */
  private insertTranscript(transcript: NewTranscript, at: string): void {
    this.db.prepare(INSERT_TRANSCRIPT).run(...transcriptRow(transcript, at));
    this.insertSegments(transcript);
    this.insertWords(transcript);
    this.reindex(transcript);
  }

  /**
   * The search index holds only the current version (KBC-039 FR-1, AC-6): the media's
   * previous rows go and the new segments come in, inside the caller's transaction.
   */
  private reindex(transcript: NewTranscript): void {
    this.db
      .prepare(
        `DELETE FROM segments_fts WHERE rowid IN (
           SELECT s.rowid FROM segments s JOIN transcripts t ON t.id = s.transcript_id
           WHERE t.media_id = ? AND t.id <> ?)`,
      )
      .run(transcript.mediaId, transcript.id);
    this.db
      .prepare(
        `INSERT INTO segments_fts (rowid, text)
         SELECT rowid, text FROM segments WHERE transcript_id = ?`,
      )
      .run(transcript.id);
  }

  private insertSegments(transcript: NewTranscript): void {
    const insert = this.db.prepare(
      `INSERT INTO segments (transcript_id, position, start_ms, end_ms, text, avg_logprob,
         compression_ratio, no_speech_prob) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    transcript.segments.forEach((one, position) =>
      insert.run(
        transcript.id,
        position,
        one.startMs,
        one.endMs,
        one.text,
        one.avgLogprob,
        one.compressionRatio,
        one.noSpeechProb,
      ),
    );
  }

  private insertWords(transcript: NewTranscript): void {
    const insert = this.db.prepare(
      `INSERT INTO words (transcript_id, position, segment_position, start_ms, end_ms,
         text, probability) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    transcript.words.forEach((one, position) =>
      insert.run(
        transcript.id,
        position,
        one.segment,
        one.startMs,
        one.endMs,
        one.text,
        one.probability,
      ),
    );
  }
}

const INSERT_TRANSCRIPT = `INSERT INTO transcripts (id, media_id, version, provider, model,
    parameters, parameters_version, terms_version, vad, speech_ratio, elapsed_ms, raw_path,
    filter_version, confidence_version, confidence, word_count, removed_words, low_words,
    created_at)
  VALUES (?, ?, (SELECT coalesce(max(version), 0) + 1 FROM transcripts WHERE media_id = ?),
    ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

/** The values of INSERT_TRANSCRIPT, in its order. */
const transcriptRow = (t: NewTranscript, at: string) =>
  [
    t.id,
    t.mediaId,
    t.mediaId,
    t.provider,
    t.model,
    t.parameters,
    t.parametersVersion,
    t.termsVersion,
    t.vad,
    t.speechRatio,
    t.elapsedMs,
    t.rawPath,
    t.filterVersion,
    t.confidenceVersion,
    t.confidence,
    t.wordCount,
    t.removedWords,
    t.lowWords,
    at,
  ] as const;
