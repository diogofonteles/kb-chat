import { randomUUID } from 'node:crypto';
import type {
  DocIngestJob,
  DocIngestResultRequest,
  DocIngestSource,
} from '@kb-chat/contracts';
import { AppError } from '../../app-error.js';
import type { RemovalRecord } from '../../ports/document-removals.js';
import type { LeaseOwner } from '../../ports/media-store.js';
import type { RemovalRecords } from './removal-records.js';

/** Moving a file and reading the collection again: minutes at most. */
export const REMOVAL_LEASE_MS = 10 * 60_000;
const MAX_ATTEMPTS = 3;

export interface RemovalQueueDeps {
  readonly records: RemovalRecords;
  /** The Mac moved it: an API that reads the same vault looks again. */
  readonly moved?: (topic: string) => void;
  /** Back, it has the level it had (ADR 0036 §5). */
  readonly placeLevel?: (record: RemovalRecord) => Promise<void>;
  readonly onError?: (err: unknown, message: string) => void;
  readonly now?: () => Date;
}

const leaseLost = () =>
  new AppError('MEDIA_CONFLICT', 'This lease is no longer yours');

/** Where the Mac left it is not where it was last asked to be, or nobody knows. */
export const isPending = (record: RemovalRecord): boolean =>
  record.isQuarantined !== (record.wish === 'removed');

const sourceOf = (record: RemovalRecord): DocIngestSource =>
  record.wish === 'removed'
    ? { kind: 'remove', document: record.document.id }
    : { kind: 'restore', document: record.document.id };

const jobOf = (
  record: RemovalRecord,
  lease: { readonly leaseId: string; readonly attempt: number },
): DocIngestJob => ({
  id: record.id,
  ...lease,
  kind: 'doc-ingest',
  topic: record.topic,
  leaseMs: REMOVAL_LEASE_MS,
  budgetUsd: 0,
  source: sourceOf(record),
});

/**
 * The Mac's side of removals (KBC-187): leased as doc-ingest jobs, before what was sent, since
 * they cost nothing and take seconds. What was asked may change while the Mac moves it: it is
 * leased again until it is where it was last asked to be.
 */
export class RemovalQueue {
  private readonly now: () => Date;

  constructor(private readonly deps: RemovalQueueDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  leasableJobs(): number {
    return this.waiting().length;
  }

  private waiting(topic?: string): RemovalRecord[] {
    return this.deps.records
      .all()
      .filter((one) => topic === undefined || one.topic === topic)
      .filter(
        (one) => isPending(one) && !one.failed && this.liveLease(one) === null,
      )
      .sort((a, b) => a.removedAt.localeCompare(b.removedAt));
  }

  private liveLease({ lease }: RemovalRecord) {
    return lease && Date.parse(lease.until) > this.now().getTime()
      ? lease
      : null;
  }

  isJob(jobId: string): boolean {
    return this.deps.records.get(jobId) !== undefined;
  }

  isHeldBy(worker: string): boolean {
    return this.deps.records
      .all()
      .some((one) => this.liveLease(one)?.worker === worker);
  }

  lease(worker: string, topic?: string): DocIngestJob | null {
    for (const record of this.waiting(topic)) {
      const attempts = record.attempts + (record.lease ? 1 : 0);
      if (attempts >= MAX_ATTEMPTS) {
        this.later(
          this.deps.records.put({
            ...record,
            ...gaveUp('the Mac lost the job too many times'),
          }),
        );
        continue;
      }
      const lease = {
        leaseId: randomUUID(),
        worker,
        until: this.until(),
        wish: record.wish,
      };
      // From here on only the Mac knows where it is.
      const asked = { attempts, lease, isQuarantined: null };
      this.later(this.deps.records.put({ ...record, ...asked }));
      return jobOf(record, { leaseId: lease.leaseId, attempt: attempts + 1 });
    }
    return null;
  }

  private until(): string {
    return new Date(this.now().getTime() + REMOVAL_LEASE_MS).toISOString();
  }

  private held(owner: LeaseOwner): RemovalRecord {
    const record = this.deps.records.get(owner.jobId);
    const lease = record?.lease;
    if (
      !record ||
      lease?.leaseId !== owner.leaseId ||
      lease.worker !== owner.worker
    )
      throw leaseLost();
    return record;
  }

  heartbeat(owner: LeaseOwner): void {
    const record = this.held(owner);
    if (!record.lease) return;
    const lease = { ...record.lease, until: this.until() };
    this.later(this.deps.records.put({ ...record, lease }));
  }

  /** Where it is now; when that is what was asked last, it ends (or waits to be asked back). */
  async complete(
    owner: LeaseOwner,
    { outcome }: Pick<DocIngestResultRequest, 'outcome'>,
  ): Promise<void> {
    const record = this.held(owner);
    if (outcome.state === 'failed') {
      await this.refuse(record, outcome.detail);
      return;
    }
    if (outcome.state !== 'moved')
      throw new AppError('VALIDATION_FAILED', 'Not an outcome of a removal');
    const isQuarantined = record.lease?.wish === 'removed';
    if (!isQuarantined) await this.deps.placeLevel?.(record);
    await this.leave(owner, isQuarantined);
    this.deps.moved?.(record.topic);
  }

  /** It ends where it was asked to be; asked otherwise while this was told, it goes on. */
  private async leave(
    owner: LeaseOwner,
    isQuarantined: boolean,
  ): Promise<void> {
    const now = this.held(owner);
    if (!isQuarantined && now.wish === 'present') {
      await this.deps.records.remove(now.id);
      return;
    }
    const told = { isQuarantined, lease: null, attempts: 0, detail: null };
    await this.deps.records.put({ ...now, ...told });
  }

  /** The Mac cannot do it as it is: said, until a person asks again. */
  private async refuse(record: RemovalRecord, detail: string): Promise<void> {
    await this.deps.records.update(record.id, (current) => ({
      ...current,
      ...gaveUp(detail),
    }));
  }

  /** A crash counts; the Mac's own setup does not. */
  async fail(
    owner: LeaseOwner,
    failure: { readonly detail: string; readonly configuration?: boolean },
  ): Promise<void> {
    const record = this.held(owner);
    const attempts = record.attempts + (failure.configuration ? 0 : 1);
    if (attempts >= MAX_ATTEMPTS) {
      await this.refuse(record, failure.detail);
      return;
    }
    await this.deps.records.update(record.id, (current) => ({
      ...current,
      attempts,
      lease: null,
      detail: failure.detail,
    }));
  }

  private later(saving: Promise<void>): void {
    saving.catch((err: unknown) =>
      this.deps.onError?.(err, 'document removals: a change was not saved'),
    );
  }
}

const gaveUp = (detail: string) => ({
  failed: true,
  lease: null,
  attempts: 0,
  detail,
});
