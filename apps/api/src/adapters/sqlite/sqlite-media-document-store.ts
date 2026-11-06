import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import type {
  DeliveredDocument,
  DesiredDocument,
  DocumentOutcome,
  LeasedKbJob,
  MediaDocumentStorePort,
  PendingDocument,
} from '../../ports/media-document-store.js';
import type { LeaseOwner } from '../../ports/media-store.js';
import { inTransaction } from './media-database.js';

const deliveredSchema = z.array(
  z.object({ mediaId: z.string(), path: z.string(), fingerprint: z.string() }),
);

/** A document kb failed on this often waits for a new render (ADR 0035 §10: 4 attempts). */
const MAX_DOCUMENT_ATTEMPTS = 4;

const HELD = `id = ? AND lease_id = ? AND worker = ? AND status = 'leased'`;
const heldArgs = (owner: LeaseOwner) =>
  [owner.jobId, owner.leaseId, owner.worker] as const;

/** `media_documents` and `kb_publish_jobs` (migration 26, ADR 0035 §3-4). */
export class SqliteMediaDocumentStore implements MediaDocumentStorePort {
  constructor(private readonly db: DatabaseSync) {}

  desire(document: DesiredDocument): boolean {
    return inTransaction(this.db, () => {
      if (this.wantsAlready(document)) return false;
      this.db
        .prepare(
          `INSERT INTO media_documents (media_id, topic, path, desired_sha256, state,
             updated_at) VALUES (?, ?, ?, ?, 'pending', ?)
           ON CONFLICT (media_id) DO UPDATE SET topic = excluded.topic,
             path = excluded.path, desired_sha256 = excluded.desired_sha256,
             state = 'pending', last_error = NULL, attempts = 0,
             updated_at = excluded.updated_at`,
        )
        .run(
          document.mediaId,
          document.topic,
          document.path,
          document.fingerprint,
          document.now.toISOString(),
        );
      return true;
    });
  }

  private wantsAlready(document: DesiredDocument): boolean {
    const row = this.db
      .prepare(
        `SELECT desired_sha256, topic, path FROM media_documents WHERE media_id = ?`,
      )
      .get(document.mediaId);
    return (
      row?.['desired_sha256'] === document.fingerprint &&
      row['topic'] === document.topic &&
      row['path'] === document.path
    );
  }

  pendingOf(topic: string, limit: number): readonly PendingDocument[] {
    return this.db
      .prepare(
        `SELECT media_id, path FROM media_documents
         WHERE topic = ? AND attempts < ? AND (published_sha256 IS NULL
           OR published_sha256 <> desired_sha256)
         ORDER BY updated_at, media_id LIMIT ?`,
      )
      .all(topic, MAX_DOCUMENT_ATTEMPTS, limit)
      .map((row) => ({
        mediaId: String(row['media_id']),
        path: String(row['path']),
      }));
  }

  liveTracks(): readonly string[] {
    return this.db
      .prepare(
        `SELECT d.media_id FROM media_documents d JOIN media m ON m.id = d.media_id
         WHERE m.status = 'ready' AND m.archived_at IS NULL
         ORDER BY m.parent_media_id, m.track_ordinal, d.media_id`,
      )
      .all()
      .map((row) => String(row['media_id']));
  }

  publishedFingerprint(mediaId: string): string | null {
    const row = this.db
      .prepare(
        'SELECT published_sha256 FROM media_documents WHERE media_id = ?',
      )
      .get(mediaId);
    const value = row?.['published_sha256'];
    return typeof value === 'string' ? value : null;
  }

  enqueue(input: { topic: string; id: string; now: Date }): void {
    const at = input.now.toISOString();
    this.db
      .prepare(
        `INSERT INTO kb_publish_jobs (id, topic, status, created_at, updated_at)
         VALUES (?, ?, 'queued', ?, ?) ON CONFLICT DO NOTHING`,
      )
      .run(input.id, input.topic, at, at);
  }

  lease(input: {
    worker: string;
    leaseId: string;
    now: Date;
    leaseMs: number;
    maxAttempts: number;
    topic?: string;
  }): LeasedKbJob | null {
    return inTransaction(this.db, () => {
      this.buryExpired(input);
      const row = this.db
        .prepare(
          `SELECT id, topic, attempts FROM kb_publish_jobs
           WHERE (status = 'queued' OR (status = 'leased' AND lease_until < ?))
             AND (? IS NULL OR topic = ?)
           ORDER BY created_at, id LIMIT 1`,
        )
        .get(input.now.getTime(), input.topic ?? null, input.topic ?? null);
      if (!row) return null;
      const job = {
        id: String(row['id']),
        leaseId: input.leaseId,
        topic: String(row['topic']),
        attempt: Number(row['attempts']) + 1,
      };
      this.take(job, input);
      return job;
    });
  }

  private take(
    job: LeasedKbJob,
    input: { worker: string; now: Date; leaseMs: number },
  ): void {
    const { now } = input;
    this.db
      .prepare(
        `UPDATE kb_publish_jobs SET status = 'leased', attempts = ?, lease_id = ?,
           worker = ?, lease_until = ?, heartbeat_at = ?, updated_at = ? WHERE id = ?`,
      )
      .run(
        job.attempt,
        job.leaseId,
        input.worker,
        now.getTime() + input.leaseMs,
        now.getTime(),
        now.toISOString(),
        job.id,
      );
  }

  /** An expired lease that already used every attempt is given up, not leased again. */
  private buryExpired(input: { now: Date; maxAttempts: number }): void {
    this.db
      .prepare(
        `UPDATE kb_publish_jobs SET status = 'dead', lease_id = NULL, lease_until = NULL,
           error = COALESCE(error, 'lease expired'), updated_at = ?
         WHERE status = 'leased' AND lease_until < ? AND attempts >= ?`,
      )
      .run(input.now.toISOString(), input.now.getTime(), input.maxAttempts);
  }

  holds(worker: string): boolean {
    return (
      this.db
        .prepare(
          `SELECT 1 FROM kb_publish_jobs WHERE worker = ? AND status = 'leased' LIMIT 1`,
        )
        .get(worker) !== undefined
    );
  }

  deliver(
    owner: LeaseOwner,
    input: { items: readonly DeliveredDocument[]; budgetUsd: number },
  ): boolean {
    return (
      this.db
        .prepare(
          `UPDATE kb_publish_jobs SET items = ?, budget_usd = ? WHERE ${HELD}`,
        )
        .run(JSON.stringify(input.items), input.budgetUsd, ...heldArgs(owner))
        .changes === 1
    );
  }

  finishEmpty(owner: LeaseOwner, now: Date): void {
    this.close(owner, { status: 'done', error: null, now });
  }

  isJob(jobId: string): boolean {
    return (
      this.db
        .prepare('SELECT 1 FROM kb_publish_jobs WHERE id = ?')
        .get(jobId) !== undefined
    );
  }

  heartbeat(owner: LeaseOwner, input: { now: Date; leaseMs: number }): boolean {
    return (
      this.db
        .prepare(
          `UPDATE kb_publish_jobs SET heartbeat_at = ?, lease_until = ?, updated_at = ?
           WHERE ${HELD}`,
        )
        .run(
          input.now.getTime(),
          input.now.getTime() + input.leaseMs,
          input.now.toISOString(),
          ...heldArgs(owner),
        ).changes === 1
    );
  }

  fail(
    owner: LeaseOwner,
    input: { error: string; now: Date; maxAttempts: number },
  ): readonly DeliveredDocument[] | null {
    return inTransaction(this.db, () => {
      const row = this.db
        .prepare(
          `SELECT topic, attempts, items FROM kb_publish_jobs WHERE ${HELD}`,
        )
        .get(...heldArgs(owner));
      if (!row) return null;
      const topic = String(row['topic']);
      const error = input.error.slice(0, 2_000);
      this.markFailed(topic, error, input.now);
      const givenUp = Number(row['attempts']) >= input.maxAttempts;
      // A newer job of the collection already waits: it publishes the same documents.
      const status = givenUp ? 'dead' : this.waits(topic) ? 'failed' : 'queued';
      this.close(owner, { status, error, now: input.now });
      return deliveredSchema.parse(JSON.parse(String(row['items'] ?? '[]')));
    });
  }

  /** The pending documents of a failed run keep its error, for the state (KBC-100). */
  private markFailed(topic: string, error: string, now: Date): void {
    this.db
      .prepare(
        `UPDATE media_documents SET last_error = ?, attempts = attempts + 1, updated_at = ?
         WHERE topic = ? AND (published_sha256 IS NULL
           OR published_sha256 <> desired_sha256)`,
      )
      .run(error, now.toISOString(), topic);
  }

  private waits(topic: string): boolean {
    return (
      this.db
        .prepare(
          `SELECT 1 FROM kb_publish_jobs WHERE topic = ? AND status = 'queued'`,
        )
        .get(topic) !== undefined
    );
  }

  complete(
    owner: LeaseOwner,
    input: { outcomes: readonly DocumentOutcome[]; now: Date },
  ): { topic: string; delivered: readonly DeliveredDocument[] } | null {
    return inTransaction(this.db, () => {
      const row = this.db
        .prepare(`SELECT topic, items FROM kb_publish_jobs WHERE ${HELD}`)
        .get(...heldArgs(owner));
      if (!row) return null;
      const delivered = deliveredSchema.parse(
        JSON.parse(String(row['items'] ?? '[]')),
      );
      for (const outcome of input.outcomes) {
        const item = delivered.find((one) => one.path === outcome.path);
        if (item) this.record(item, outcome, input.now);
      }
      this.close(owner, { status: 'done', error: null, now: input.now });
      return { topic: String(row['topic']), delivered };
    });
  }

  /** The document as published, with the fingerprint it was rendered with (BR-2). */
  private record(
    item: DeliveredDocument,
    outcome: DocumentOutcome,
    now: Date,
  ): void {
    const at = now.toISOString();
    if (outcome.ok)
      this.db
        .prepare(
          `UPDATE media_documents SET published_sha256 = ?, published_at = ?,
             state = CASE WHEN desired_sha256 = ? THEN 'published' ELSE 'pending' END,
             last_error = NULL, updated_at = ? WHERE media_id = ?`,
        )
        .run(item.fingerprint, at, item.fingerprint, at, item.mediaId);
    else
      this.db
        .prepare(
          `UPDATE media_documents SET state = 'failed', last_error = ?,
             attempts = attempts + 1, updated_at = ? WHERE media_id = ?`,
        )
        .run((outcome.error ?? 'kb failed').slice(0, 2_000), at, item.mediaId);
  }

  private close(
    owner: LeaseOwner,
    outcome: { status: string; error: string | null; now: Date },
  ): void {
    this.db
      .prepare(
        `UPDATE kb_publish_jobs SET status = ?, error = ?, lease_id = NULL,
           lease_until = NULL, updated_at = ? WHERE ${HELD}`,
      )
      .run(
        outcome.status,
        outcome.error,
        outcome.now.toISOString(),
        ...heldArgs(owner),
      );
  }
}
