import type { DatabaseSync, SQLOutputValue } from 'node:sqlite';
import {
  rawChunkResultSchema,
  type RawChunkResult,
  type TranscriptionHold,
} from '@kb-chat/contracts';
import type {
  GroqChunkKey,
  GroqQueuePort,
  WaitingTranscription,
} from '../../ports/groq-queue.js';
import type { LeaseOwner } from '../../ports/media-store.js';
import { groqBackToTranscriber } from './sqlite-leases.js';

type Row = Record<string, SQLOutputValue>;

const WAITING = `SELECT j.id, j.media_id, j.route, j.created_at, m.duration_ms
  FROM jobs j JOIN media m ON m.id = j.media_id
  WHERE j.kind = 'transcribe' AND j.status = 'queued'`;

const waitingOf = (row: Row): WaitingTranscription => ({
  jobId: String(row['id']),
  mediaId: String(row['media_id']),
  durationMs: row['duration_ms'] === null ? null : Number(row['duration_ms']),
  route: row['route'] === 'groq' ? 'groq' : 'transcriber',
  createdAt: String(row['created_at']),
});

/** The Groq fallback's view of the queue in `media.db` (KBC-037). */
export class SqliteGroqQueue implements GroqQueuePort {
  constructor(private readonly db: DatabaseSync) {}

  waitingSince(queuedBefore: Date): WaitingTranscription[] {
    return this.db
      .prepare(
        `${WAITING} AND j.route IS NULL AND j.created_at < ?
         ORDER BY j.created_at, j.id`,
      )
      .all(queuedBefore.toISOString())
      .map(waitingOf);
  }

  waitingOf(mediaId: string): WaitingTranscription | null {
    const row = this.db
      .prepare(
        `${WAITING} AND j.media_id = ? ORDER BY j.created_at DESC, j.rowid DESC LIMIT 1`,
      )
      .get(mediaId);
    return row ? waitingOf(row) : null;
  }

  routeToGroq(input: { jobId: string; now: Date }): boolean {
    // Groq counts its own attempts; the Mac's wait in `transcriber_attempts` meanwhile.
    const result = this.db
      .prepare(
        `UPDATE jobs SET route = 'groq', hold = NULL, transcriber_attempts = attempts,
           attempts = 0, updated_at = ?
         WHERE id = ? AND kind = 'transcribe' AND status = 'queued' AND route IS NULL`,
      )
      .run(input.now.toISOString(), input.jobId);
    return result.changes === 1;
  }

  hold(input: { jobId: string; hold: TranscriptionHold; now: Date }): void {
    this.db
      .prepare(
        `UPDATE jobs SET hold = ?, updated_at = ?
         WHERE id = ? AND status = 'queued' AND route IS NULL`,
      )
      .run(input.hold, input.now.toISOString(), input.jobId);
  }

  heldGroqJob(
    owner: LeaseOwner,
  ): { mediaId: string; durationMs: number | null } | null {
    const row = this.db
      .prepare(
        `SELECT j.media_id, m.duration_ms FROM jobs j JOIN media m ON m.id = j.media_id
         WHERE j.id = ? AND j.lease_id = ? AND j.worker = ? AND j.status = 'leased'
           AND j.kind = 'transcribe' AND j.route = 'groq'`,
      )
      .get(owner.jobId, owner.leaseId, owner.worker);
    if (!row) return null;
    return {
      mediaId: String(row['media_id']),
      durationMs:
        row['duration_ms'] === null ? null : Number(row['duration_ms']),
    };
  }

  backToTranscriber(input: {
    owner: LeaseOwner;
    hold: TranscriptionHold | null;
    now: Date;
  }): boolean {
    if (!this.heldGroqJob(input.owner)) return false;
    return groqBackToTranscriber(this.db, {
      jobId: input.owner.jobId,
      hold: input.hold,
      error: null,
      at: input.now.toISOString(),
    });
  }

  handBack(input: { owner: LeaseOwner; now: Date }): boolean {
    const { owner } = input;
    const result = this.db
      .prepare(
        `UPDATE jobs SET status = 'queued', attempts = max(attempts - 1, 0), lease_id = NULL,
           lease_until = NULL, worker = NULL, updated_at = ?
         WHERE id = ? AND lease_id = ? AND worker = ? AND status = 'leased'
           AND kind = 'transcribe' AND route = 'groq'`,
      )
      .run(input.now.toISOString(), owner.jobId, owner.leaseId, owner.worker);
    return result.changes === 1;
  }

  committedMs(): number {
    const row = this.db
      .prepare(
        `SELECT coalesce(sum(max(0, coalesce(m.duration_ms, 0) - coalesce(
             (SELECT sum(c.end_ms - c.start_ms) FROM groq_chunks c WHERE c.job_id = j.id), 0))),
           0) AS ms
         FROM jobs j JOIN media m ON m.id = j.media_id
         WHERE j.kind = 'transcribe' AND j.route = 'groq'
           AND j.status IN ('queued', 'leased')`,
      )
      .get();
    return Number(row?.['ms'] ?? 0);
  }

  conversionsWaiting(): boolean {
    return (
      this.db
        .prepare(
          `SELECT 1 FROM jobs WHERE status = 'queued' AND kind IN ('transcode', 'cut')
           LIMIT 1`,
        )
        .get() !== undefined
    );
  }

  savedChunk(key: GroqChunkKey): RawChunkResult | null {
    const row = this.db
      .prepare(
        `SELECT result FROM groq_chunks
         WHERE job_id = ? AND start_ms = ? AND end_ms = ? AND terms_version = ?`,
      )
      .get(key.jobId, key.startMs, key.endMs, key.termsVersion);
    return row
      ? rawChunkResultSchema.parse(JSON.parse(String(row['result'])))
      : null;
  }

  saveChunk(input: {
    key: GroqChunkKey;
    result: RawChunkResult;
    now: Date;
  }): void {
    const { key } = input;
    this.db
      .prepare(
        `INSERT OR REPLACE INTO groq_chunks
           (job_id, start_ms, end_ms, terms_version, result, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        key.jobId,
        key.startMs,
        key.endMs,
        key.termsVersion,
        JSON.stringify(input.result),
        input.now.toISOString(),
      );
  }

  forgetEndedChunks(): number {
    return Number(
      this.db
        .prepare(
          `DELETE FROM groq_chunks WHERE job_id NOT IN
             (SELECT id FROM jobs WHERE status IN ('queued', 'leased'))`,
        )
        .run().changes,
    );
  }
}
