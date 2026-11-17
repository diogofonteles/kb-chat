import { randomUUID } from 'node:crypto';
import type { Readable } from 'node:stream';
import type {
  DocIngestJob,
  DocIngestResultRequest,
  DocIngestSource,
  DocIngestStateRequest,
  KbCollection,
} from '@kb-chat/contracts';
import { AppError } from '../../app-error.js';
import type {
  DocumentUploadFilesPort,
  DocumentUploadRecord,
} from '../../ports/document-uploads.js';
import type { LeaseOwner } from '../../ports/media-store.js';
import type { UploadRecords } from './upload-records.js';

/** A Mac holds a doc-ingest job this long between heartbeats (conversion runs in steps). */
export const DOC_INGEST_LEASE_MS = 10 * 60 * 1000;
/** Crashes and lost leases a document survives before it is given up. */
export const DOC_INGEST_MAX_ATTEMPTS = 3;

/** The states the Mac works in: a lease in one of them is live until it expires. */
const WORKING = new Set(['converting', 'classifying', 'mapping']);

export interface DocIngestQueueDeps {
  readonly records: UploadRecords;
  readonly files: DocumentUploadFilesPort;
  /** What kb may spend now (the media month's ceiling, ADR 0035 §11); zero waits. */
  readonly budgetUsd: () => number;
  /** What `kb topic new` needs for a collection created on the screen (KBC-114). */
  readonly collectionOf?: (topic: string) => KbCollection | null;
  /** The document is born at the upload's level (ADR 0036 §5): placed before it arrives. */
  readonly placeLevel?: (
    record: DocumentUploadRecord,
    documentId: string,
  ) => Promise<void>;
  /** kb's spend, booked on the media month like kb-publish's (ADR 0035 §11). */
  readonly book?: (record: DocumentUploadRecord, usd: number) => void;
  /** A YouTube link's audio becomes a media item of the sender (KBC-142 BR-5). */
  readonly adoptAudio?: (
    record: DocumentUploadRecord,
    audio: {
      readonly body: Readable;
      readonly bytes: number;
      readonly name: string;
    },
  ) => Promise<string>;
  readonly onError?: (err: unknown, message: string) => void;
  readonly now?: () => Date;
}

const leaseLost = () =>
  new AppError('MEDIA_CONFLICT', 'This lease is no longer yours');

/**
 * The Mac's side of sent documents (KBC-149 FR-2, ADR 0040): the oldest received document
 * is leased with its source, the Mac says each step, and its result (or failure, with why)
 * ends the job. Kept apart from the media `jobs` (no media item), as kb-publish is.
 */
export class DocIngestQueue {
  private readonly now: () => Date;

  constructor(private readonly deps: DocIngestQueueDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  /** Documents a Mac could lease now (for the waker); none with the ceiling spent. */
  leasableJobs(): number {
    if (this.deps.budgetUsd() <= 0) return 0;
    const now = this.now().getTime();
    return this.deps.records.all().filter((one) => this.isLeasable(one, now))
      .length;
  }

  private isLeasable(record: DocumentUploadRecord, now: number): boolean {
    if (record.state === 'received') return true;
    return (
      WORKING.has(record.state) &&
      record.lease !== null &&
      Date.parse(record.lease.until) <= now
    );
  }

  isJob(jobId: string): boolean {
    return this.deps.records.get(jobId) !== undefined;
  }

  isHeldBy(worker: string): boolean {
    const now = this.now().getTime();
    return this.deps.records
      .all()
      .some(
        (one) =>
          one.lease?.worker === worker &&
          WORKING.has(one.state) &&
          Date.parse(one.lease.until) > now,
      );
  }

  /**
   * The oldest leasable document; a lease that expired counts as an attempt spent. In the
   * map at once (one writer), saved in the background: a lease lost to a crash is leased again.
   */
  lease(worker: string): DocIngestJob | null {
    const budgetUsd = this.deps.budgetUsd();
    if (budgetUsd <= 0) return null;
    const now = this.now();
    const waiting = this.deps.records
      .all()
      .filter((one) => this.isLeasable(one, now.getTime()))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    for (const record of waiting) {
      const attempts = record.attempts + (record.lease ? 1 : 0);
      if (attempts >= DOC_INGEST_MAX_ATTEMPTS) {
        this.later(this.giveUp(record, 'the Mac lost the job too many times'));
        continue;
      }
      const leased: DocumentUploadRecord = {
        ...record,
        attempts,
        state: 'converting',
        lease: {
          leaseId: randomUUID(),
          worker,
          until: new Date(now.getTime() + DOC_INGEST_LEASE_MS).toISOString(),
        },
        updatedAt: now.toISOString(),
      };
      this.later(this.deps.records.put(leased));
      return this.jobOf(leased, budgetUsd);
    }
    return null;
  }

  private jobOf(record: DocumentUploadRecord, budgetUsd: number): DocIngestJob {
    const collection = this.deps.collectionOf?.(record.topic) ?? null;
    return {
      ...(collection && { collection }),
      id: record.id,
      leaseId: record.lease?.leaseId ?? '',
      kind: 'doc-ingest',
      topic: record.topic,
      attempt: record.attempts + 1,
      leaseMs: DOC_INGEST_LEASE_MS,
      budgetUsd,
      source: sourceOf(record),
    };
  }

  /** The record this lease holds, still live; else 409 (the Mac drops its work). */
  private held(owner: LeaseOwner): DocumentUploadRecord {
    const record = this.deps.records.get(owner.jobId);
    if (
      !record ||
      !record.lease ||
      record.lease.leaseId !== owner.leaseId ||
      record.lease.worker !== owner.worker ||
      !WORKING.has(record.state)
    )
      throw leaseLost();
    return record;
  }

  heartbeat(owner: LeaseOwner): void {
    const record = this.held(owner);
    const until = new Date(this.now().getTime() + DOC_INGEST_LEASE_MS);
    const lease = { ...owner, until: until.toISOString() };
    this.later(
      this.deps.records.put({
        ...record,
        lease: {
          leaseId: lease.leaseId,
          worker: lease.worker,
          until: lease.until,
        },
      }),
    );
  }

  /** A save that the caller does not wait for: a failure is logged, never lost silently. */
  private later(saving: Promise<void>): void {
    saving.catch((err: unknown) =>
      this.deps.onError?.(err, 'document uploads: a change was not saved'),
    );
  }

  /** FR-2: the step the Mac is on now. */
  async step(owner: LeaseOwner, request: DocIngestStateRequest): Promise<void> {
    const record = this.held(owner);
    await this.deps.records.put({
      ...record,
      state: request.state,
      updatedAt: this.now().toISOString(),
    });
  }

  /** The file as sent, for the Mac (only while it holds the job). */
  async fileOf(owner: LeaseOwner): Promise<{ path: string; size: number }> {
    const record = this.held(owner);
    const file =
      record.kind === 'file' ? await this.deps.files.find(record.id) : null;
    if (!file) throw new AppError('NOT_FOUND', 'No such file for this job');
    return file;
  }

  /**
   * How it ended (FR-2, FR-3, AC-4): ready (on its way to the app with the next sync), the
   * document it repeats, or failed with why; the file is kept only until then.
   */
  async complete(
    owner: LeaseOwner,
    result: DocIngestResultRequest,
  ): Promise<void> {
    const record = this.held(owner);
    const { outcome } = result;
    // A level placed before the document arrives: it is never "Sem nível" (ADR 0036 §5).
    if (outcome.state === 'ready' && record.level)
      await this.deps.placeLevel?.(record, outcome.document.id);
    await this.deps.records.put({
      ...record,
      ...endOf(outcome),
      lease: null,
      spentUsd: record.spentUsd + result.spendUsd,
      updatedAt: this.now().toISOString(),
    });
    if (result.spendUsd > 0) this.deps.book?.(record, result.spendUsd);
    await this.deps.files.remove(record.id);
  }

  /**
   * A crash, or the Mac's own setup (KBC-117: no kb key). A setup failure waits without
   * spending an attempt; a crash is retried until the attempts run out.
   */
  async fail(
    owner: LeaseOwner,
    failure: {
      readonly detail: string;
      readonly configuration?: boolean;
      readonly spendUsd?: number;
    },
  ): Promise<void> {
    const record = this.held(owner);
    const attempts = record.attempts + (failure.configuration ? 0 : 1);
    if ((failure.spendUsd ?? 0) > 0)
      this.deps.book?.(record, failure.spendUsd ?? 0);
    if (attempts >= DOC_INGEST_MAX_ATTEMPTS) {
      await this.giveUp({ ...record, attempts }, failure.detail);
      return;
    }
    await this.deps.records.put({
      ...record,
      attempts,
      state: 'received',
      detail: failure.detail,
      lease: null,
      updatedAt: this.now().toISOString(),
    });
  }

  /** A YouTube link's audio, downloaded on the Mac, goes to the library as the sender's. */
  async adopt(
    owner: LeaseOwner,
    audio: {
      readonly body: Readable;
      readonly bytes: number;
      readonly name: string;
    },
  ): Promise<string> {
    const record = this.held(owner);
    if (record.kind !== 'youtube' || !this.deps.adoptAudio)
      throw new AppError('NOT_FOUND', 'No such audio for this job');
    const mediaId = await this.deps.adoptAudio(record, audio);
    await this.deps.records.put({
      ...record,
      state: 'transcribing',
      mediaId,
      lease: null,
      updatedAt: this.now().toISOString(),
    });
    return mediaId;
  }

  private async giveUp(
    record: DocumentUploadRecord,
    detail: string,
  ): Promise<void> {
    await this.deps.records.put({
      ...record,
      state: 'failed',
      failure: 'gave-up',
      detail,
      lease: null,
      updatedAt: this.now().toISOString(),
    });
    await this.deps.files.remove(record.id);
  }
}

/** What a result leaves on the record: failed with why, or done on the Mac ("no mapa"). */
function endOf(
  outcome: DocIngestResultRequest['outcome'],
): Pick<DocumentUploadRecord, 'state' | 'failure' | 'detail' | 'document'> {
  if (outcome.state === 'failed')
    return {
      state: 'failed',
      failure: outcome.failure,
      detail: outcome.detail,
      document: null,
    };
  const repeated = outcome.state === 'duplicate';
  return {
    state: 'mapped',
    failure: null,
    detail: repeated ? 'already in the collection' : null,
    document: outcome.document,
  };
}

const jobPath = (id: string, what: string) =>
  `/api/v1/media-worker/jobs/${id}/${what}`;

function sourceOf(record: DocumentUploadRecord): DocIngestSource {
  if (record.kind === 'file')
    return {
      kind: 'file',
      name: record.name,
      bytes: record.bytes ?? 0,
      sha256: record.sha256 ?? '',
      filePath: jobPath(record.id, 'document'),
    };
  if (record.kind === 'youtube')
    return {
      kind: 'youtube',
      url: record.url ?? '',
      audioPath: jobPath(record.id, 'youtube-audio'),
    };
  return { kind: 'url', url: record.url ?? '' };
}
