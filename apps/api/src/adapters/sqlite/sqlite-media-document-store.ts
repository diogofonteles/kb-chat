import type { DatabaseSync, StatementSync } from 'node:sqlite';
import { transcriptConfidenceSchema } from '@kb-chat/contracts';
import { z } from 'zod';
import type {
  DeliveredDocument,
  DesiredDocument,
  DocumentCounts,
  DocumentOutcome,
  DocumentStatus,
  LeasedKbJob,
  MediaDocumentStorePort,
  PendingDocument,
  PublishableTrack,
  QueueSummary,
  VaultSyncRecord,
} from '../../ports/media-document-store.js';
import type { LeaseOwner } from '../../ports/media-store.js';
import type { ShelfRow } from '../../ports/track-shelf.js';
import { inTransaction } from './media-database.js';

/** Jobs leased before KBC-100 delivered writes only, with no `op`. */
const deliveredSchema = z.array(
  z.union([
    z.object({
      op: z.literal('remove'),
      mediaId: z.string(),
      path: z.string(),
    }),
    z
      .object({
        op: z.literal('write').default('write'),
        mediaId: z.string(),
        path: z.string(),
        fingerprint: z.string(),
      })
      .transform((one) => ({ ...one, op: 'write' as const })),
  ]),
);

/** Not yet what production sees: never published, or published with another text. */
const NOT_PUBLISHED = `(published_sha256 IS NULL OR published_sha256 <> desired_sha256)`;

/** A transcribed recording that never had a track: its whole text is one document (FR-7). */
const UNTRACKED_RECORDING = `m.parent_media_id IS NULL AND m.status = 'ready'
  AND m.archived_at IS NULL AND NOT EXISTS (SELECT 1 FROM media c WHERE c.parent_media_id = m.id)`;

const FAILED_SHOWN = 20;

/** A track the renderer can make a document of: it has a transcript of its own. */
const HAS_TRANSCRIPT = `EXISTS (SELECT 1 FROM transcripts t WHERE t.media_id = m.id)`;

/**
 * A transcription that is, or is to be, a document (KBC-114 BR-8): a live track, or a live
 * recording that never had a track; either with a transcript of its own.
 */
const PUBLISHABLE = `((m.parent_media_id IS NOT NULL AND m.status = 'ready'
  AND m.archived_at IS NULL) OR (${UNTRACKED_RECORDING})) AND ${HAS_TRANSCRIPT}`;

/** A kb-publish job a Mac may lease: waiting, or leased and expired (taken back). */
const KB_LEASABLE = `(status = 'queued' OR (status = 'leased' AND lease_until < ?))`;

/** A document kb failed on this often waits for a new render (ADR 0035 §10: 4 attempts). */
const MAX_DOCUMENT_ATTEMPTS = 4;

const HELD = `id = ? AND lease_id = ? AND worker = ? AND status = 'leased'`;
const heldArgs = (owner: LeaseOwner) =>
  [owner.jobId, owner.leaseId, owner.worker] as const;

/** `media_documents` and `kb_publish_jobs` (migration 26, ADR 0035 §3-4). */
export class SqliteMediaDocumentStore implements MediaDocumentStorePort {
  private anyTrack: StatementSync | undefined;
  private desired: StatementSync | undefined;
  private shelf: StatementSync | undefined;

  constructor(private readonly db: DatabaseSync) {}

  desire(document: DesiredDocument): boolean {
    return inTransaction(this.db, () => {
      if (this.wantsAlready(document)) return false;
      this.leaveOldPlace(document);
      this.db
        .prepare(
          'DELETE FROM media_document_removals WHERE topic = ? AND path = ?',
        )
        .run(document.topic, document.path);
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

  /**
   * A document wanted elsewhere now (a move): the old file goes (BR-2, AC-6). One never
   * published there has no file; one a running job is writing there is removed when its
   * result comes (`complete`).
   */
  private leaveOldPlace(document: DesiredDocument): void {
    const row = this.db
      .prepare(
        'SELECT topic, path, published_sha256 FROM media_documents WHERE media_id = ?',
      )
      .get(document.mediaId);
    if (!row || row['published_sha256'] === null) return;
    const topic = String(row['topic']);
    const path = String(row['path']);
    if (topic === document.topic && path === document.path) return;
    this.queueRemoval({ topic, path, mediaId: document.mediaId }, document.now);
  }

  private queueRemoval(
    place: { topic: string; path: string; mediaId: string },
    now: Date,
  ): void {
    const at = now.toISOString();
    this.db
      .prepare(
        `INSERT INTO media_document_removals (topic, path, media_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (topic, path) DO UPDATE SET media_id = excluded.media_id,
           attempts = 0, last_error = NULL, updated_at = excluded.updated_at`,
      )
      .run(place.topic, place.path, place.mediaId, at, at);
  }

  retire(mediaId: string, now: Date): string | null {
    return inTransaction(this.db, () => {
      const row = this.db
        .prepare(
          'SELECT topic, path, published_sha256 FROM media_documents WHERE media_id = ?',
        )
        .get(mediaId);
      if (!row) return null;
      const topic = String(row['topic']);
      // Never published: no file to remove (a running job's is handled by `complete`).
      if (row['published_sha256'] !== null)
        this.queueRemoval({ topic, path: String(row['path']), mediaId }, now);
      this.db
        .prepare('DELETE FROM media_documents WHERE media_id = ?')
        .run(mediaId);
      return topic;
    });
  }

  removalsOf(topic: string, limit: number): readonly PendingDocument[] {
    return this.db
      .prepare(
        `SELECT media_id, path FROM media_document_removals
         WHERE topic = ? AND attempts < ? ORDER BY updated_at, path LIMIT ?`,
      )
      .all(topic, MAX_DOCUMENT_ATTEMPTS, limit)
      .map((row) => ({
        mediaId: String(row['media_id']),
        path: String(row['path']),
      }));
  }

  hasPending(topic: string): boolean {
    return (
      this.pendingOf(topic, 1).length > 0 ||
      this.removalsOf(topic, 1).length > 0
    );
  }

  documented(): readonly string[] {
    return this.db
      .prepare('SELECT media_id FROM media_documents ORDER BY topic, path')
      .all()
      .map((row) => String(row['media_id']));
  }

  documentedUnder(recordingId: string): readonly string[] {
    return this.db
      .prepare(
        `SELECT media_id FROM media_documents WHERE substr(path, 1, ?) = ?
         ORDER BY path`,
      )
      .all(`raw/media/${recordingId}/`.length, `raw/media/${recordingId}/`)
      .map((row) => String(row['media_id']));
  }

  undocumentedRecordings(
    perTopic: number,
  ): readonly { mediaId: string; topic: string }[] {
    return this.db
      .prepare(
        `SELECT id, topic FROM (
           SELECT m.id, m.topic, ROW_NUMBER() OVER (PARTITION BY m.topic
             ORDER BY m.created_at, m.id) AS place
           FROM media m
           WHERE ${UNTRACKED_RECORDING} AND ${HAS_TRANSCRIPT}
             AND NOT EXISTS (SELECT 1 FROM media_documents d WHERE d.media_id = m.id))
         WHERE place <= ? ORDER BY id`,
      )
      .all(perTopic)
      .map((row) => ({
        mediaId: String(row['id']),
        topic: String(row['topic']),
      }));
  }

  hasTracks(recordingId: string): boolean {
    // Asked once per track document a search or a topic list checks: prepared once.
    this.anyTrack ??= this.db.prepare(
      'SELECT 1 FROM media WHERE parent_media_id = ? LIMIT 1',
    );
    return this.anyTrack.get(recordingId) !== undefined;
  }

  statusOf(mediaId: string): DocumentStatus | null {
    const row = this.db
      .prepare(
        `SELECT topic, desired_sha256, live_sha256, live_at, attempts, last_error,
           updated_at FROM media_documents WHERE media_id = ?`,
      )
      .get(mediaId);
    if (!row) return null;
    const text = (value: unknown) => (typeof value === 'string' ? value : null);
    return {
      topic: String(row['topic']),
      desiredFingerprint: String(row['desired_sha256']),
      liveFingerprint: text(row['live_sha256']),
      liveAt: text(row['live_at']),
      attempts: Number(row['attempts']),
      lastError: text(row['last_error']),
      updatedAt: String(row['updated_at']),
    };
  }

  retry(mediaId: string, now: Date): readonly string[] {
    const at = now.toISOString();
    return inTransaction(this.db, () => {
      const documents = this.db
        .prepare(
          `UPDATE media_documents SET attempts = 0, state = 'pending', last_error = NULL,
             updated_at = ? WHERE media_id = ? RETURNING topic`,
        )
        .all(at, mediaId);
      // Only removals given up on: one still being tried keeps its place in the queue.
      const removals = this.db
        .prepare(
          `UPDATE media_document_removals SET attempts = 0, last_error = NULL, updated_at = ?
           WHERE media_id = ? AND attempts >= ? RETURNING topic`,
        )
        .all(at, mediaId, MAX_DOCUMENT_ATTEMPTS);
      return [
        ...new Set(
          [...documents, ...removals].map((row) => String(row['topic'])),
        ),
      ];
    });
  }

  markLive(
    seen: readonly { mediaId: string; fingerprint: string }[],
    now: Date,
  ): number {
    return inTransaction(this.db, () => {
      const update = this.db.prepare(
        `UPDATE media_documents SET live_sha256 = ?, live_at = ?
         WHERE media_id = ? AND desired_sha256 = ? AND live_sha256 IS NOT ?`,
      );
      let changed = 0;
      for (const one of seen)
        changed += Number(
          update.run(
            one.fingerprint,
            now.toISOString(),
            one.mediaId,
            one.fingerprint,
            one.fingerprint,
          ).changes,
        );
      return changed;
    });
  }

  queueSummary(): QueueSummary {
    const counts = this.db
      .prepare(
        `SELECT
           (SELECT COUNT(*) FROM media_documents
              WHERE (live_sha256 IS NULL OR live_sha256 <> desired_sha256)
                AND NOT (attempts >= ? AND ${NOT_PUBLISHED}))
           + (SELECT COUNT(*) FROM media_document_removals WHERE attempts < ?) AS waiting,
           (SELECT MAX(published_at) FROM media_documents) AS last_published`,
      )
      // What failed is under "Falhou", never counted as waiting (review 5).
      .get(MAX_DOCUMENT_ATTEMPTS, MAX_DOCUMENT_ATTEMPTS);
    const last = counts?.['last_published'];
    return {
      waiting: Number(counts?.['waiting'] ?? 0),
      lastPublishedAt: typeof last === 'string' ? last : null,
      failed: this.failed(),
    };
  }

  /**
   * The documents and the removals given up on, newest first: what masters may retry. A
   * media with both (a move) shows once, by its newest row (SQLite takes the other columns
   * from the row MAX picks); one deleted since is named by its file. Read up to the shown
   * count only, however long kb has been failing (review suggestion).
   */
  private failed(): QueueSummary['failed'] {
    const rows = this.db
      .prepare(
        `SELECT media_id, topic, title, last_error, MAX(updated_at) AS updated_at FROM (
           SELECT d.media_id, d.topic, COALESCE(m.title, '') AS title, d.last_error,
             d.updated_at FROM media_documents d LEFT JOIN media m ON m.id = d.media_id
           WHERE d.attempts >= ? AND ${NOT_PUBLISHED}
           UNION ALL
           SELECT r.media_id, r.topic, COALESCE(m.title, r.path), r.last_error, r.updated_at
           FROM media_document_removals r LEFT JOIN media m ON m.id = r.media_id
           WHERE r.attempts >= ?)
         GROUP BY media_id
         ORDER BY updated_at DESC, media_id
         LIMIT ?`,
      )
      .all(MAX_DOCUMENT_ATTEMPTS, MAX_DOCUMENT_ATTEMPTS, FAILED_SHOWN);
    return rows.map((row) => ({
      mediaId: String(row['media_id']),
      topic: String(row['topic']),
      title: String(row['title']),
      error: String(row['last_error'] ?? 'kb failed'),
      since: String(row['updated_at']),
    }));
  }

  recordSync(sync: VaultSyncRecord): void {
    this.db
      .prepare(
        `INSERT INTO vault_syncs (id, worker, ok, detail, started_at, finished_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        sync.id,
        sync.worker,
        sync.ok ? 1 : 0,
        sync.detail.slice(-2_000),
        sync.startedAt,
        sync.finishedAt,
      );
  }

  lastSync(): VaultSyncRecord | null {
    const row = this.db
      .prepare(
        `SELECT id, worker, ok, detail, started_at, finished_at FROM vault_syncs
         ORDER BY finished_at DESC, id DESC LIMIT 1`,
      )
      .get();
    if (!row) return null;
    return {
      id: String(row['id']),
      worker: String(row['worker']),
      ok: Number(row['ok']) === 1,
      detail: String(row['detail']),
      startedAt: String(row['started_at']),
      finishedAt: String(row['finished_at']),
    };
  }

  private stillWantedAt(
    topic: string,
    item: { mediaId: string; path: string },
  ) {
    const row = this.db
      .prepare('SELECT topic, path FROM media_documents WHERE media_id = ?')
      .get(item.mediaId);
    return row?.['topic'] === topic && row['path'] === item.path;
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
         WHERE topic = ? AND attempts < ? AND ${NOT_PUBLISHED}
         ORDER BY updated_at, media_id LIMIT ?`,
      )
      .all(topic, MAX_DOCUMENT_ATTEMPTS, limit)
      .map((row) => ({
        mediaId: String(row['media_id']),
        path: String(row['path']),
      }));
  }

  publishableTracks(topic?: string): readonly PublishableTrack[] {
    const rows = this.db
      .prepare(
        `SELECT m.id, m.topic FROM media m
         WHERE ${PUBLISHABLE} AND (? IS NULL OR m.topic = ?)
         ORDER BY m.topic, COALESCE(m.parent_media_id, m.id), m.track_ordinal, m.id`,
      )
      .all(topic ?? null, topic ?? null);
    return rows.map((row) => ({
      mediaId: String(row['id']),
      topic: String(row['topic']),
    }));
  }

  /** Counted from the rows, never by rendering (review round 2: a GET every 20 s). */
  countsOf(topic: string): DocumentCounts {
    const row = this.db
      .prepare(
        `SELECT
           COALESCE(SUM(d.media_id IS NULL), 0) AS undocumented,
           COALESCE(SUM(d.state = 'pending'), 0) AS queued,
           COALESCE(SUM(d.state = 'published'), 0) AS published,
           COALESCE(SUM(d.state = 'failed'), 0) AS failed
         FROM media m LEFT JOIN media_documents d ON d.media_id = m.id
         WHERE m.topic = ? AND ${PUBLISHABLE}`,
      )
      .get(topic);
    return {
      undocumented: Number(row?.['undocumented'] ?? 0),
      queued: Number(row?.['queued'] ?? 0),
      published: Number(row?.['published'] ?? 0),
      failed: Number(row?.['failed'] ?? 0),
    };
  }

  /**
   * Every media of a collection as the track shelf needs it, in one query (KBC-101 NFR-3):
   * live (ready, not archived), a track or a recording, its current transcript's confidence.
   */
  shelfRows(topic: string): ReadonlyMap<string, ShelfRow> {
    this.shelf ??= this.db.prepare(
      `SELECT m.id, m.title, m.parent_media_id IS NOT NULL AS is_track,
         m.status = 'ready' AND m.archived_at IS NULL AS live,
         (SELECT t.confidence FROM transcripts t WHERE t.media_id = m.id
            ORDER BY t.version DESC LIMIT 1) AS confidence
       FROM media m WHERE m.topic = ?`,
    );
    const rows = new Map<string, ShelfRow>();
    for (const row of this.shelf.all(topic)) {
      const id = String(row['id']);
      const confidence = row['confidence'];
      rows.set(id, {
        id,
        title: String(row['title']),
        live: Number(row['live']) === 1,
        isTrack: Number(row['is_track']) === 1,
        confidence:
          typeof confidence === 'string'
            ? transcriptConfidenceSchema.parse(confidence)
            : null,
      });
    }
    return rows;
  }

  desiredFingerprint(mediaId: string): string | null {
    this.desired ??= this.db.prepare(
      'SELECT desired_sha256 FROM media_documents WHERE media_id = ?',
    );
    const row = this.desired.get(mediaId);
    return row ? String(row['desired_sha256']) : null;
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

  leasableJobs(input: { now: Date; maxAttempts: number }): number {
    // The lease's own predicate, without the expired leases it would bury first.
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS ready FROM kb_publish_jobs
         WHERE ${KB_LEASABLE} AND NOT (status = 'leased' AND attempts >= ?)`,
      )
      .get(input.now.getTime(), input.maxAttempts);
    return Number(row?.['ready'] ?? 0);
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
           WHERE ${KB_LEASABLE} AND (? IS NULL OR topic = ?)
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
      const delivered = deliveredSchema.parse(
        JSON.parse(String(row['items'] ?? '[]')),
      );
      this.markFailed(topic, { delivered, error, now: input.now });
      const givenUp = Number(row['attempts']) >= input.maxAttempts;
      // A newer job of the collection already waits: it publishes the same documents.
      const status = givenUp ? 'dead' : this.waits(topic) ? 'failed' : 'queued';
      this.close(owner, { status, error, now: input.now });
      return delivered;
    });
  }

  /**
   * What a failed run delivered keeps its error and spends an attempt (BR-5: four, then
   * **Falhou**). Only what it delivered: a document changed meanwhile starts over.
   */
  private markFailed(
    topic: string,
    input: {
      delivered: readonly DeliveredDocument[];
      error: string;
      now: Date;
    },
  ): void {
    const at = input.now.toISOString();
    const write = this.db.prepare(
      `UPDATE media_documents SET last_error = ?, attempts = attempts + 1, updated_at = ?
       WHERE media_id = ? AND desired_sha256 = ?`,
    );
    const remove = this.db.prepare(
      `UPDATE media_document_removals SET last_error = ?, attempts = attempts + 1,
         updated_at = ? WHERE topic = ? AND path = ?`,
    );
    for (const item of input.delivered)
      if (item.op === 'write')
        write.run(input.error, at, item.mediaId, item.fingerprint);
      else remove.run(input.error, at, topic, item.path);
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
      const topic = String(row['topic']);
      for (const outcome of input.outcomes) {
        const item = delivered.find((one) => one.path === outcome.path);
        if (item?.op === 'write')
          this.record({ topic, item, outcome }, input.now);
        else if (item) this.recordRemoval({ topic, item, outcome }, input.now);
      }
      this.close(owner, { status: 'done', error: null, now: input.now });
      return { topic, delivered };
    });
  }

  /** A removal done is forgotten; one kb or the Mac failed on spends an attempt. */
  private recordRemoval(
    input: {
      topic: string;
      item: DeliveredDocument;
      outcome: DocumentOutcome;
    },
    now: Date,
  ): void {
    const { topic, item, outcome } = input;
    if (outcome.ok)
      this.db
        .prepare(
          `DELETE FROM media_document_removals WHERE topic = ? AND path = ?
             AND media_id = ?`,
        )
        .run(topic, item.path, item.mediaId);
    else
      this.db
        .prepare(
          `UPDATE media_document_removals SET last_error = ?, attempts = attempts + 1,
             updated_at = ? WHERE topic = ? AND path = ?`,
        )
        .run(
          (outcome.error ?? 'kb failed').slice(0, 2_000),
          now.toISOString(),
          topic,
          item.path,
        );
  }

  /** The document as published, with the fingerprint it was rendered with (BR-2). */
  private record(
    input: {
      topic: string;
      item: Extract<DeliveredDocument, { op: 'write' }>;
      outcome: DocumentOutcome;
    },
    now: Date,
  ): void {
    const { topic, item, outcome } = input;
    const at = now.toISOString();
    if (outcome.ok && !this.stillWantedAt(topic, item)) {
      // Retired or moved while the Mac wrote it: the file it just wrote goes again.
      this.queueRemoval({ topic, path: item.path, mediaId: item.mediaId }, now);
      return;
    }
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
