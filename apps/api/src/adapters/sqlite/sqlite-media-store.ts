import { randomUUID } from 'node:crypto';
import type { DatabaseSync, SQLOutputValue } from 'node:sqlite';
import {
  mediaFailureSchema,
  mediaJobKindSchema,
  mediaStatusSchema,
  transcriptConfidenceSchema,
  type MediaJobKind,
} from '@kb-chat/contracts';
import type {
  Heartbeat,
  JobStatus,
  JobFailure,
  LeaseOwner,
  LeaseRequest,
  LeasedJob,
  MediaRecord,
  MediaRendition,
  MediaStorePort,
  NewMedia,
  ReapResult,
  TranscodeResult,
} from '../../ports/media-store.js';
import { inTransaction } from './media-database.js';
import { closeLease } from './sqlite-leases.js';

type Row = Record<string, SQLOutputValue>;

const text = (row: Row, column: string): string => String(row[column]);
const nullableNumber = (row: Row, column: string): number | null =>
  row[column] === null ? null : Number(row[column]);

/** A media row, read back through the contract's enums so a bad row fails loudly. */
function toMediaRecord(row: Row): MediaRecord {
  return {
    id: text(row, 'id'),
    topic: text(row, 'topic'),
    title: text(row, 'title'),
    author: row['author'] === null ? null : text(row, 'author'),
    ownerPrincipal: text(row, 'owner_principal'),
    fileName: text(row, 'file_name'),
    uploadBytes: Number(row['upload_bytes']),
    status: mediaStatusSchema.parse(row['status']),
    progress: nullableNumber(row, 'progress'),
    failure:
      row['failure'] === null ? null : mediaFailureSchema.parse(row['failure']),
    durationMs: nullableNumber(row, 'duration_ms'),
    bytes: nullableNumber(row, 'bytes'),
    createdAt: text(row, 'created_at'),
    updatedAt: text(row, 'updated_at'),
    transcription: {
      jobStatus:
        row['transcribe_job'] === null
          ? null
          : jobStatusOf(row['transcribe_job']),
      version: nullableNumber(row, 'transcript_version'),
      confidence:
        row['transcript_confidence'] === null
          ? null
          : transcriptConfidenceSchema.parse(row['transcript_confidence']),
    },
  };
}

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

/** The item, its newest transcribe job and its current transcript (KBC-036). */
const MEDIA_COLUMNS = `id, topic, title, author, owner_principal, file_name, upload_bytes,
  status, progress, failure, duration_ms, bytes, created_at, updated_at,
  (SELECT j.status FROM jobs j WHERE j.media_id = media.id AND j.kind = 'transcribe'
     ORDER BY j.created_at DESC, j.rowid DESC LIMIT 1) AS transcribe_job,
  (SELECT t.version FROM transcripts t WHERE t.media_id = media.id
     ORDER BY t.version DESC LIMIT 1) AS transcript_version,
  (SELECT t.confidence FROM transcripts t WHERE t.media_id = media.id
     ORDER BY t.version DESC LIMIT 1) AS transcript_confidence`;

/** The media catalog and its queue in SQLite (ADR 0022); the API is the only writer. */
export class SqliteMediaStore implements MediaStorePort {
  constructor(private readonly db: DatabaseSync) {}

  createMedia(media: NewMedia): MediaRecord {
    const at = media.now.toISOString();
    this.db
      .prepare(
        `INSERT INTO media (id, topic, title, author, authorship, owner_principal,
           file_name, upload_bytes, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'uploading', ?, ?)`,
      )
      .run(
        media.id,
        media.topic,
        media.title,
        media.author,
        media.legacyAuthorship,
        media.ownerPrincipal,
        media.fileName,
        media.uploadBytes,
        at,
        at,
      );
    return this.requireMedia(media.id);
  }

  getMedia(id: string): MediaRecord | null {
    const row = this.db
      .prepare(`SELECT ${MEDIA_COLUMNS} FROM media WHERE id = ?`)
      .get(id);
    return row ? toMediaRecord(row) : null;
  }

  listMedia(topic: string): MediaRecord[] {
    return this.db
      .prepare(
        `SELECT ${MEDIA_COLUMNS} FROM media WHERE topic = ?
         ORDER BY created_at DESC, id`,
      )
      .all(topic)
      .map(toMediaRecord);
  }

  topicsWithAuthor(author: string): string[] {
    return this.db
      .prepare(
        'SELECT DISTINCT topic FROM media WHERE author = ? ORDER BY topic',
      )
      .all(author)
      .map((row) => text(row, 'topic'));
  }

  markUploaded(input: {
    mediaId: string;
    jobId: string;
    now: Date;
  }): MediaRecord {
    const at = input.now.toISOString();
    return inTransaction(this.db, () => {
      const changed = this.db
        .prepare(
          `UPDATE media SET status = 'queued', updated_at = ?
           WHERE id = ? AND status = 'uploading'`,
        )
        .run(at, input.mediaId).changes;
      if (changed !== 1)
        throw new Error(`media ${input.mediaId} is not uploading`);
      this.insertJob({
        id: input.jobId,
        mediaId: input.mediaId,
        kind: 'transcode',
        at,
      });
      return this.requireMedia(input.mediaId);
    });
  }

  getRendition(mediaId: string): MediaRendition | null {
    const row = this.db
      .prepare(
        `SELECT media_id, path, bytes, mime FROM media_files
         WHERE media_id = ? AND rendition = 'audio'`,
      )
      .get(mediaId);
    if (!row) return null;
    return {
      mediaId: text(row, 'media_id'),
      rendition: 'audio',
      path: text(row, 'path'),
      bytes: Number(row['bytes']),
      mime: text(row, 'mime'),
    };
  }

  deleteMedia(id: string): boolean {
    return (
      this.db.prepare('DELETE FROM media WHERE id = ?').run(id).changes === 1
    );
  }

  retryMedia(input: { mediaId: string; now: Date }): MediaRecord {
    const at = input.now.toISOString();
    return inTransaction(this.db, () => {
      this.db.prepare('DELETE FROM jobs WHERE media_id = ?').run(input.mediaId);
      this.db
        .prepare(
          `UPDATE media SET status = 'queued', failure = NULL, progress = NULL,
             updated_at = ? WHERE id = ?`,
        )
        .run(at, input.mediaId);
      this.insertJob({
        id: randomUUID(),
        mediaId: input.mediaId,
        kind: 'transcode',
        at,
      });
      return this.requireMedia(input.mediaId);
    });
  }

  leaseJob(request: LeaseRequest): LeasedJob | null {
    if (request.kinds.length === 0) return null;
    return inTransaction(this.db, () => {
      if (request.oneAtATime && this.holdsLease(request.worker)) return null;
      const row = this.takeOldestQueued(request);
      if (!row) return null;
      const job = toLeasedJob(row);
      // A transcription never changes the item's own status: it stays playable.
      if (job.kind === 'transcode')
        this.setMediaProgress({
          mediaId: job.mediaId,
          status: 'processing',
          progress: 0,
          at: request.now.toISOString(),
        });
      return job;
    });
  }

  private holdsLease(worker: string): boolean {
    return (
      this.db
        .prepare(
          `SELECT 1 FROM jobs WHERE worker = ? AND status = 'leased' LIMIT 1`,
        )
        .get(worker) !== undefined
    );
  }

  /** What a job is (conversion or transcription); null when it does not exist. */
  kindOfJob(jobId: string): MediaJobKind | null {
    const row = this.db
      .prepare('SELECT kind FROM jobs WHERE id = ?')
      .get(jobId);
    return row ? mediaJobKindSchema.parse(row['kind']) : null;
  }

  heartbeat(beat: Heartbeat): boolean {
    return inTransaction(this.db, () => {
      const changed = this.db
        .prepare(
          `UPDATE jobs SET heartbeat_at = ?, lease_until = ?, updated_at = ?
           WHERE id = ? AND lease_id = ? AND worker = ? AND status = 'leased'`,
        )
        .run(
          beat.now.getTime(),
          beat.now.getTime() + beat.leaseMs,
          beat.now.toISOString(),
          beat.jobId,
          beat.leaseId,
          beat.worker,
        ).changes;
      if (changed !== 1) return false;
      const job = this.db
        .prepare('SELECT media_id, kind FROM jobs WHERE id = ?')
        .get(beat.jobId);
      // Only a conversion's progress is the item's (a transcription has its own status).
      if (job?.['kind'] === 'transcode' && beat.progress !== null)
        this.setMediaProgress({
          mediaId: text(job, 'media_id'),
          status: 'processing',
          progress: beat.progress,
          at: beat.now.toISOString(),
        });
      return true;
    });
  }

  completeTranscode(result: TranscodeResult): boolean {
    const at = result.now.toISOString();
    return inTransaction(this.db, () => {
      if (!this.closeLease(result, { status: 'done', error: null, at }))
        return false;
      this.saveRendition(result, at);
      this.insertJob({
        id: result.transcribeJobId,
        mediaId: result.rendition.mediaId,
        kind: 'transcribe',
        at,
      });
      return true;
    });
  }

  /** The rendition is the item's playable file; the item is ready. */
  private saveRendition(result: TranscodeResult, at: string): void {
    const { rendition } = result;
    this.db
      .prepare(
        `INSERT OR REPLACE INTO media_files (media_id, rendition, path, bytes, mime)
         VALUES (?, 'audio', ?, ?, ?)`,
      )
      .run(rendition.mediaId, rendition.path, rendition.bytes, rendition.mime);
    this.db
      .prepare(
        `UPDATE media SET status = 'ready', progress = NULL, failure = NULL,
           duration_ms = ?, bytes = ?, updated_at = ? WHERE id = ?`,
      )
      .run(result.durationMs, rendition.bytes, at, rendition.mediaId);
  }

  failJob(failure: JobFailure): boolean {
    const at = failure.now.toISOString();
    return inTransaction(this.db, () => {
      const held = this.heldBy(failure);
      if (held === null) return false;
      const permanent = failure.failure === 'invalid-audio';
      const givenUp = permanent || held.attempts >= failure.maxAttempts;
      const status = givenUp ? (permanent ? 'failed' : 'dead') : 'queued';
      this.closeLease(failure, {
        status,
        error: failure.detail.slice(0, 2_000),
        at,
      });
      // A failed transcription leaves the item playable as it is.
      if (held.kind === 'transcribe') return true;
      if (givenUp)
        this.failMedia({
          mediaId: this.requireMediaOfJob(failure.jobId),
          failure: failure.failure,
          at,
        });
      else
        this.setMediaProgress({
          mediaId: this.requireMediaOfJob(failure.jobId),
          status: 'queued',
          progress: null,
          at,
        });
      return true;
    });
  }

  reapExpired(input: { now: Date; maxAttempts: number }): ReapResult {
    const at = input.now.toISOString();
    return inTransaction(this.db, () => {
      const expired = this.db
        .prepare(
          `SELECT id, media_id, kind, attempts FROM jobs
           WHERE status = 'leased' AND lease_until < ?`,
        )
        .all(input.now.getTime());
      let failed = 0;
      const transcriptionsGivenUp: string[] = [];
      for (const row of expired) {
        const givenUp = Number(row['attempts']) >= input.maxAttempts;
        const mediaId = text(row, 'media_id');
        this.releaseExpired({ jobId: text(row, 'id'), givenUp, at });
        if (givenUp) failed++;
        if (row['kind'] === 'transcode')
          this.afterExpiry({ mediaId, givenUp, at });
        else if (givenUp) transcriptionsGivenUp.push(mediaId);
      }
      return {
        requeued: expired.length - failed,
        failed,
        transcriptionsGivenUp,
      };
    });
  }

  abandonUploads(input: { olderThan: Date; now: Date }): string[] {
    return inTransaction(this.db, () => {
      const rows = this.db
        .prepare(
          `SELECT id FROM media WHERE status = 'uploading' AND created_at < ?`,
        )
        .all(input.olderThan.toISOString());
      const ids = rows.map((row) => text(row, 'id'));
      for (const mediaId of ids)
        this.failMedia({
          mediaId,
          failure: 'upload-abandoned',
          at: input.now.toISOString(),
        });
      return ids;
    });
  }

  close(): void {
    if (this.db.isOpen) this.db.close();
  }

  private requireMedia(id: string): MediaRecord {
    const media = this.getMedia(id);
    if (!media) throw new Error(`media ${id} does not exist`);
    return media;
  }

  private insertJob(job: {
    id: string;
    mediaId: string;
    kind: MediaJobKind;
    at: string;
  }): void {
    this.db
      .prepare(
        `INSERT INTO jobs (id, media_id, kind, status, created_at, updated_at)
         VALUES (?, ?, ?, 'queued', ?, ?)`,
      )
      .run(job.id, job.mediaId, job.kind, job.at, job.at);
  }

  /** The oldest queued job of the asked kinds, leased in the same statement. */
  private takeOldestQueued(request: LeaseRequest): Row | undefined {
    // Only placeholders are built here; the kinds are bound values (ND-16).
    const kinds = request.kinds.map(() => '?').join(', ');
    return this.db
      .prepare(
        `UPDATE jobs SET status = 'leased', attempts = attempts + 1, lease_id = ?,
           worker = ?, lease_until = ?, heartbeat_at = ?, updated_at = ?
         WHERE id = (SELECT id FROM jobs WHERE status = 'queued' AND kind IN (${kinds})
                     ORDER BY created_at, id LIMIT 1)
         RETURNING id, lease_id, kind, media_id, attempts`,
      )
      .get(
        randomUUID(),
        request.worker,
        request.now.getTime() + request.leaseMs,
        request.now.getTime(),
        request.now.toISOString(),
        ...request.kinds,
      );
  }

  private closeLease(
    owner: LeaseOwner,
    outcome: { status: string; error: string | null; at: string },
  ): boolean {
    return closeLease(this.db, owner, outcome);
  }

  private heldBy(
    owner: LeaseOwner,
  ): { attempts: number; kind: MediaJobKind } | null {
    const row = this.db
      .prepare(
        `SELECT attempts, kind FROM jobs
         WHERE id = ? AND lease_id = ? AND worker = ? AND status = 'leased'`,
      )
      .get(owner.jobId, owner.leaseId, owner.worker);
    return row
      ? {
          attempts: Number(row['attempts']),
          kind: mediaJobKindSchema.parse(row['kind']),
        }
      : null;
  }

  private releaseExpired(input: {
    jobId: string;
    givenUp: boolean;
    at: string;
  }): void {
    this.db
      .prepare(
        `UPDATE jobs SET status = ?, lease_id = NULL, lease_until = NULL, worker = NULL,
           error = ?, updated_at = ? WHERE id = ?`,
      )
      .run(
        input.givenUp ? 'dead' : 'queued',
        input.givenUp ? 'lease expired too many times' : null,
        input.at,
        input.jobId,
      );
  }

  private afterExpiry(input: {
    mediaId: string;
    givenUp: boolean;
    at: string;
  }): void {
    if (input.givenUp)
      this.failMedia({
        mediaId: input.mediaId,
        failure: 'too-many-attempts',
        at: input.at,
      });
    else
      this.setMediaProgress({
        mediaId: input.mediaId,
        status: 'queued',
        progress: null,
        at: input.at,
      });
  }

  private setMediaProgress(input: {
    mediaId: string;
    status: 'queued' | 'processing';
    progress: number | null;
    at: string;
  }): void {
    this.db
      .prepare(
        'UPDATE media SET status = ?, progress = ?, updated_at = ? WHERE id = ?',
      )
      .run(input.status, input.progress, input.at, input.mediaId);
  }

  private failMedia(input: {
    mediaId: string;
    failure: string;
    at: string;
  }): void {
    this.db
      .prepare(
        `UPDATE media SET status = 'failed', failure = ?, progress = NULL, updated_at = ?
         WHERE id = ?`,
      )
      .run(input.failure, input.at, input.mediaId);
  }

  mediaOfJob(jobId: string): string | null {
    const row = this.db
      .prepare('SELECT media_id FROM jobs WHERE id = ?')
      .get(jobId);
    return row ? text(row, 'media_id') : null;
  }

  private requireMediaOfJob(jobId: string): string {
    const mediaId = this.mediaOfJob(jobId);
    if (!mediaId) throw new Error(`job ${jobId} does not exist`);
    return mediaId;
  }
}

function toLeasedJob(row: Row): LeasedJob {
  return {
    id: text(row, 'id'),
    leaseId: text(row, 'lease_id'),
    kind: mediaJobKindSchema.parse(row['kind']),
    mediaId: text(row, 'media_id'),
    attempt: Number(row['attempts']),
  };
}
