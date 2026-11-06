import { randomUUID } from 'node:crypto';
import {
  KB_PUBLISH_MAX_BUDGET_USD,
  KB_PUBLISH_MAX_ITEMS,
  type CompleteKbPublishRequest,
  type KbPublishJob,
} from '@kb-chat/contracts';
import { AppError } from '../../app-error.js';
import { startOfAppMonth } from '../../app-calendar.js';
import type {
  DeliveredDocument,
  LeasedKbJob,
  MediaDocumentStorePort,
} from '../../ports/media-document-store.js';
import type { MediaSpendLedgerPort } from '../../ports/media-spend-ledger.js';
import type { LeaseOwner } from '../../ports/media-store.js';
import type { MediaDocumentReconciler, TrackRender } from './reconciler.js';

export interface KbPublishServiceDeps {
  readonly documents: MediaDocumentStorePort;
  readonly reconciler: MediaDocumentReconciler;
  /** The media monthly ledger (ADR 0035 §11): kb spends on it. */
  readonly spend: Pick<MediaSpendLedgerPort, 'usedSince' | 'reserve' | 'close'>;
  readonly monthlyCapUsd: number;
  readonly leaseMs: number;
  readonly maxAttempts: number;
  readonly now?: () => Date;
}

/** Why a kb-publish job failed on the Mac, and what kb spent before it did. */
export interface KbFailure {
  readonly detail: string;
  readonly spendUsd?: number;
}

/** A job rendered nothing (every document already out): tried again this many times. */
const EMPTY_LEASES = 5;

const leaseLost = () =>
  new AppError('MEDIA_CONFLICT', 'This lease is no longer yours');

const ownerOf = (job: LeasedKbJob, worker: string): LeaseOwner => ({
  jobId: job.id,
  leaseId: job.leaseId,
  worker,
});

/**
 * The kb-publish queue as the Mac sees it (ADR 0035 §3): a lease renders the collection's
 * documents still to publish at that moment, at most 50, with the budget kb may spend; the
 * result marks each document published with the fingerprint it was rendered with and books
 * kb's spend on the media ledger. The API never writes to the vault (Q7).
 */
export class KbPublishService {
  private readonly now: () => Date;

  constructor(private readonly deps: KbPublishServiceDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  /** What kb may still spend this month, capped per job; zero leaves the queue waiting. */
  budgetUsd(): number {
    const used = this.deps.spend.usedSince(startOfAppMonth(this.now()));
    const left = Math.max(0, this.deps.monthlyCapUsd - used);
    return Math.min(KB_PUBLISH_MAX_BUDGET_USD, Math.floor(left * 1e4) / 1e4);
  }

  /** The next waiting job, rendered now; `topic` keeps to one collection (E2E's fake Mac). */
  lease(worker: string, topic?: string): KbPublishJob | null {
    const budgetUsd = this.budgetUsd();
    if (budgetUsd <= 0) return null;
    for (let tries = 0; tries < EMPTY_LEASES; tries += 1) {
      const job = this.deps.documents.lease({
        worker,
        leaseId: randomUUID(),
        now: this.now(),
        leaseMs: this.deps.leaseMs,
        maxAttempts: this.deps.maxAttempts,
        ...(topic && { topic }),
      });
      if (!job) return null;
      const items = this.renderPending(job.topic);
      const owner = ownerOf(job, worker);
      if (items.length > 0) {
        this.deps.documents.deliver(owner, {
          items: items.map(delivered),
          budgetUsd,
        });
        return this.toJob(job, { items, budgetUsd });
      }
      this.deps.documents.finishEmpty(owner, this.now());
    }
    return null;
  }

  private toJob(
    job: LeasedKbJob,
    { items, budgetUsd }: { items: readonly TrackRender[]; budgetUsd: number },
  ): KbPublishJob {
    return {
      id: job.id,
      leaseId: job.leaseId,
      kind: 'kb-publish',
      topic: job.topic,
      attempt: job.attempt,
      leaseMs: this.deps.leaseMs,
      budgetUsd,
      items: items.map(({ path, markdown, fingerprint }) => ({
        op: 'write' as const,
        path,
        markdown,
        fingerprint,
      })),
    };
  }

  /** The newest render of each document still to publish (coalesced, ADR 0035 §4). */
  private renderPending(topic: string): TrackRender[] {
    return this.deps.documents
      .pendingOf(topic, KB_PUBLISH_MAX_ITEMS)
      .map(({ mediaId }) => this.deps.reconciler.render(mediaId))
      .filter((one): one is TrackRender => one?.topic === topic);
  }

  isJob(jobId: string): boolean {
    return this.deps.documents.isJob(jobId);
  }

  isHeldBy(worker: string): boolean {
    return this.deps.documents.holds(worker);
  }

  heartbeat(owner: LeaseOwner): void {
    const held = this.deps.documents.heartbeat(owner, {
      now: this.now(),
      leaseMs: this.deps.leaseMs,
    });
    if (!held) throw leaseLost();
  }

  /**
   * A failed step: the job goes back with kb's output; the written files stay (AC-4). What
   * kb spent before failing (a step that spent, then a later one failed) is booked on the
   * delivered documents in equal shares: never lost (ADR 0035 §11).
   */
  fail(owner: LeaseOwner, failure: KbFailure): void {
    const now = this.now();
    const delivered = this.deps.documents.fail(owner, {
      error: failure.detail,
      now,
      maxAttempts: this.deps.maxAttempts,
    });
    if (!delivered) throw leaseLost();
    const spent = failure.spendUsd ?? 0;
    if (spent <= 0 || delivered.length === 0) return;
    const share = spent / delivered.length;
    for (const item of delivered)
      this.settle({ worker: owner.worker, mediaId: item.mediaId, usd: share, now });
  }

  complete(owner: LeaseOwner, result: CompleteKbPublishRequest): void {
    const now = this.now();
    const done = this.deps.documents.complete(owner, {
      outcomes: result.documents,
      now,
    });
    if (!done) throw leaseLost();
    this.book(owner, { result, delivered: done.delivered, now });
    // Changed meanwhile, or past the first 50: the next job takes them.
    this.deps.reconciler.enqueueIfPending(done.topic);
  }

  /** kb's spend per document, settled on the media ledger (ADR 0035 §11, PD-09). */
  private book(
    owner: LeaseOwner,
    input: {
      result: CompleteKbPublishRequest;
      delivered: readonly DeliveredDocument[];
      now: Date;
    },
  ): void {
    for (const outcome of input.result.documents) {
      const item = input.delivered.find((one) => one.path === outcome.path);
      if (!item || outcome.spendUsd <= 0) continue;
      this.settle({
        worker: owner.worker,
        mediaId: item.mediaId,
        usd: outcome.spendUsd,
        now: input.now,
      });
    }
  }

  /** One spend of kb on a document's line of the media ledger, already settled. */
  private settle(spend: {
    worker: string;
    mediaId: string;
    usd: number;
    now: Date;
  }): void {
    const id = randomUUID();
    this.deps.spend.reserve({
      id,
      kind: 'kb-publish',
      mediaId: spend.mediaId,
      principal: spend.worker,
      usd: spend.usd,
      // Already spent on kb's own key: booked whatever the cap says, never lost.
      capUsd: Number.MAX_VALUE,
      since: startOfAppMonth(spend.now),
      now: spend.now,
    });
    this.deps.spend.close({
      id,
      spentUsd: spend.usd,
      outcome: 'settled',
      now: spend.now,
    });
  }
}

const delivered = (render: TrackRender): DeliveredDocument => ({
  mediaId: render.mediaId,
  path: render.path,
  fingerprint: render.fingerprint,
});
