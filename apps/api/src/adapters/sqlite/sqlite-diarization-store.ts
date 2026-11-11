import type { DatabaseSync, SQLOutputValue } from 'node:sqlite';
import type { SpeakerTurn } from '@kb-chat/contracts';
import type {
  DiarizationStorePort,
  DiarizationSummary,
  DiarizeJobRecord,
  NewDiarization,
} from '../../ports/diarization-store.js';
import type { JobStatus, LeaseOwner } from '../../ports/media-store.js';
import { inTransaction } from './media-database.js';
import { closeLease } from './sqlite-leases.js';

type Row = Record<string, SQLOutputValue>;

const text = (row: Row, column: string): string => String(row[column]);
const nullableNumber = (row: Row, column: string): number | null =>
  row[column] === null || row[column] === undefined
    ? null
    : Number(row[column]);

const JOB_STATUSES: readonly JobStatus[] = [
  'queued',
  'leased',
  'done',
  'failed',
  'dead',
];

function jobStatusOf(value: unknown): JobStatus {
  const status = JOB_STATUSES.find((one) => one === value);
  if (!status) throw new Error(`unknown job status ${String(value)}`);
  return status;
}

function toSummary(row: Row): DiarizationSummary {
  return {
    id: text(row, 'id'),
    mediaId: text(row, 'media_id'),
    version: Number(row['version']),
    transcriptId: text(row, 'transcript_id'),
    requestedVoices: nullableNumber(row, 'requested_voices'),
    voiceCount: Number(row['voice_count']),
    rawPath: text(row, 'raw_path'),
    derivationVersion: Number(row['derivation_version']),
    createdAt: text(row, 'created_at'),
    namesPending: row['names_pending'] === 1,
  };
}

/** Voice separations in the media database (ADR 0029 §1); turns and voices, never prints. */
export class SqliteDiarizationStore implements DiarizationStorePort {
  constructor(private readonly db: DatabaseSync) {}

  requestDiarization(input: {
    mediaId: string;
    jobId: string;
    voices: number | null;
    now: Date;
  }): boolean {
    const at = input.now.toISOString();
    return inTransaction(this.db, () => {
      const pending = this.db
        .prepare(
          `SELECT 1 FROM jobs WHERE media_id = ? AND kind = 'diarize'
             AND status IN ('queued', 'leased')`,
        )
        .get(input.mediaId);
      if (pending) return false;
      this.db
        .prepare(
          `INSERT INTO jobs (id, media_id, kind, status, voices, created_at, updated_at)
           VALUES (?, ?, 'diarize', 'queued', ?, ?, ?)`,
        )
        .run(input.jobId, input.mediaId, input.voices, at, at);
      return true;
    });
  }

  heldDiarization(
    owner: LeaseOwner,
  ): { mediaId: string; voices: number | null } | null {
    const row = this.db
      .prepare(
        `SELECT media_id, voices FROM jobs WHERE id = ? AND lease_id = ? AND worker = ?
           AND status = 'leased' AND kind = 'diarize'`,
      )
      .get(owner.jobId, owner.leaseId, owner.worker);
    return row
      ? {
          mediaId: text(row, 'media_id'),
          voices: nullableNumber(row, 'voices'),
        }
      : null;
  }

  completeDiarize(input: {
    owner: LeaseOwner;
    diarization: NewDiarization;
    now: Date;
  }): boolean {
    const at = input.now.toISOString();
    return inTransaction(this.db, () => {
      if (
        !closeLease(this.db, input.owner, { status: 'done', error: null, at })
      )
        return false;
      this.insert(input.diarization, at);
      return true;
    });
  }

  latestJob(mediaId: string): DiarizeJobRecord | null {
    const row = this.db
      .prepare(
        `SELECT status, voices FROM jobs WHERE media_id = ? AND kind = 'diarize'
         ORDER BY created_at DESC, rowid DESC LIMIT 1`,
      )
      .get(mediaId);
    return row
      ? {
          status: jobStatusOf(row['status']),
          voices: nullableNumber(row, 'voices'),
        }
      : null;
  }

  latest(mediaId: string): DiarizationSummary | null {
    const row = this.db
      .prepare(
        `SELECT id, media_id, version, transcript_id, requested_voices, voice_count,
           raw_path, derivation_version, created_at, names_pending
         FROM diarizations WHERE media_id = ? ORDER BY version DESC LIMIT 1`,
      )
      .get(mediaId);
    return row ? toSummary(row) : null;
  }

  turns(diarizationId: string): SpeakerTurn[] {
    return this.db
      .prepare(
        `SELECT voice, start_ms, end_ms FROM media_speaker_turns
         WHERE diarization_id = ? ORDER BY position`,
      )
      .all(diarizationId)
      .map((row) => ({
        voice: Number(row['voice']),
        startMs: Number(row['start_ms']),
        endMs: Number(row['end_ms']),
      }));
  }

  segmentVoices(diarizationId: string): (number | null)[] {
    return this.voicesOf(
      'media_segment_voices',
      'segment_position',
      diarizationId,
    );
  }

  wordVoices(diarizationId: string): (number | null)[] {
    return this.voicesOf('media_word_voices', 'word_position', diarizationId);
  }

  private voicesOf(
    table: 'media_segment_voices' | 'media_word_voices',
    position: 'segment_position' | 'word_position',
    diarizationId: string,
  ): (number | null)[] {
    // Only the two fixed table names above reach the SQL; the id is bound (ND-16).
    return this.db
      .prepare(
        `SELECT voice FROM ${table} WHERE diarization_id = ? ORDER BY ${position}`,
      )
      .all(diarizationId)
      .map((row) => nullableNumber(row, 'voice'));
  }

  /** The newest version of the item gets the next number. */
  private insert(diarization: NewDiarization, at: string): void {
    this.db.prepare(INSERT_DIARIZATION).run(...diarizationRow(diarization, at));
    const turn = this.db.prepare(
      `INSERT INTO media_speaker_turns (diarization_id, position, voice, start_ms, end_ms)
       VALUES (?, ?, ?, ?, ?)`,
    );
    diarization.turns.forEach((one, position) =>
      turn.run(diarization.id, position, one.voice, one.startMs, one.endMs),
    );
    const segment = this.db.prepare(
      `INSERT INTO media_segment_voices (diarization_id, segment_position, voice)
       VALUES (?, ?, ?)`,
    );
    diarization.segmentVoices.forEach((voice, position) =>
      segment.run(diarization.id, position, voice),
    );
    const word = this.db.prepare(
      `INSERT INTO media_word_voices (diarization_id, word_position, voice)
       VALUES (?, ?, ?)`,
    );
    diarization.wordVoices.forEach((voice, position) =>
      word.run(diarization.id, position, voice),
    );
    this.insertLabels(diarization);
  }

  /** The names carried over from the separation before (KBC-065 FR-5). */
  private insertLabels({ id, labels }: NewDiarization): void {
    const label = this.db.prepare(
      `INSERT INTO media_voice_labels (diarization_id, voice, speaker_id, audience)
       VALUES (?, ?, ?, ?)`,
    );
    labels.forEach((one) =>
      label.run(id, one.voice, one.speakerId, one.audience ? 1 : 0),
    );
  }
}

const INSERT_DIARIZATION = `INSERT INTO diarizations (id, media_id, version, transcript_id,
    engine, model, parameters, parameters_version, requested_voices, voice_count, elapsed_ms,
    raw_path, derivation_version, created_at, names_pending)
  VALUES (?, ?, (SELECT coalesce(max(version), 0) + 1 FROM diarizations WHERE media_id = ?),
    ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

/** The values of INSERT_DIARIZATION, in its order. */
const diarizationRow = (d: NewDiarization, at: string) =>
  [
    d.id,
    d.mediaId,
    d.mediaId,
    d.transcriptId,
    d.engine,
    d.model,
    d.parameters,
    d.parametersVersion,
    d.requestedVoices,
    d.voiceCount,
    d.elapsedMs,
    d.rawPath,
    d.derivationVersion,
    at,
    d.namesPending ? 1 : 0,
  ] as const;
