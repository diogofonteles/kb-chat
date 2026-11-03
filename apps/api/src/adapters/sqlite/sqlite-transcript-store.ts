import type { DatabaseSync, SQLOutputValue } from 'node:sqlite';
import {
  mediaJobKindSchema,
  transcriptConfidenceSchema,
  type TranscriptionTerms,
} from '@kb-chat/contracts';
import type { LeaseOwner } from '../../ports/media-store.js';
import type {
  DerivedSegment,
  DerivedWord,
  JobLease,
  NewTranscript,
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
    confidence: transcriptConfidenceSchema.parse(row['confidence']),
    vad: vadOf(row['vad']),
    rawPath: text(row, 'raw_path'),
    filterVersion: Number(row['filter_version']),
    confidenceVersion: Number(row['confidence_version']),
    wordCount: Number(row['word_count']),
    removedWords: Number(row['removed_words']),
    createdAt: text(row, 'created_at'),
  };
}

/** Transcripts and the term list in the media database (ADR 0022 §1, ADR 0023). */
export class SqliteTranscriptStore implements TranscriptStorePort {
  constructor(private readonly db: DatabaseSync) {}

  currentTerms(): TranscriptionTerms {
    const rows = this.db
      .prepare(
        `SELECT version, term FROM terms
         WHERE version = (SELECT max(version) FROM terms) ORDER BY position`,
      )
      .all();
    const first = rows[0];
    if (!first) throw new Error('the media database has no term list');
    return {
      version: Number(first['version']),
      terms: rows.map((row) => text(row, 'term')),
    };
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
  }): boolean {
    const at = input.now.toISOString();
    return inTransaction(this.db, () => {
      if (
        !closeLease(this.db, input.owner, { status: 'done', error: null, at })
      )
        return false;
      this.insertTranscript(input.transcript, at);
      return true;
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
    return this.db
      .prepare(
        `SELECT id, media_id, version, confidence, vad, raw_path, filter_version,
           confidence_version, word_count, removed_words, created_at
         FROM transcripts WHERE media_id = ? ORDER BY version DESC`,
      )
      .all(mediaId)
      .map(toSummary);
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

  words(transcriptId: string): DerivedWord[] {
    return this.db
      .prepare(
        `SELECT segment_position, start_ms, end_ms, text, probability
         FROM words WHERE transcript_id = ? ORDER BY position`,
      )
      .all(transcriptId)
      .map((row) => ({
        segment: Number(row['segment_position']),
        startMs: Number(row['start_ms']),
        endMs: Number(row['end_ms']),
        text: text(row, 'text'),
        probability: nullableNumber(row, 'probability'),
      }));
  }

  /** The newest version of the item gets the next number (BR-3: the newest is current). */
  private insertTranscript(transcript: NewTranscript, at: string): void {
    this.db.prepare(INSERT_TRANSCRIPT).run(...transcriptRow(transcript, at));
    this.insertSegments(transcript);
    this.insertWords(transcript);
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
