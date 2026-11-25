import type { DocIngestJob, DocIngestResultRequest } from '@kb-chat/contracts';
import type { LeaseOwner } from '../../ports/media-store.js';
import type { DocIngestWork } from '../document-uploads/index.js';
import type { RemovalQueue } from './removal-queue.js';

export interface VaultJobsDeps {
  readonly docs: DocIngestWork;
  readonly removals: RemovalQueue;
  /** A document entered under this id: if one was removed from there, it is another now. */
  readonly entered: (jobId: string, documentId: string) => Promise<void>;
}

/**
 * What the publishing Mac does in a collection, as one queue (KBC-187): removals first (they
 * cost nothing and take seconds), then what was sent.
 */
export class VaultJobs implements DocIngestWork {
  constructor(private readonly deps: VaultJobsDeps) {}

  private of(jobId: string): DocIngestWork | RemovalQueue {
    const { docs, removals } = this.deps;
    return removals.isJob(jobId) ? removals : docs;
  }

  leasableJobs(): number {
    return this.deps.removals.leasableJobs() + this.deps.docs.leasableJobs();
  }

  isJob(jobId: string): boolean {
    return this.of(jobId).isJob(jobId);
  }

  isHeldBy(worker: string): boolean {
    const { docs, removals } = this.deps;
    return removals.isHeldBy(worker) || docs.isHeldBy(worker);
  }

  lease(worker: string, topic?: string): DocIngestJob | null {
    const { docs, removals } = this.deps;
    return removals.lease(worker, topic) ?? docs.lease(worker, topic);
  }

  heartbeat(owner: LeaseOwner): void {
    this.of(owner.jobId).heartbeat(owner);
  }

  fail(
    owner: LeaseOwner,
    failure: Parameters<DocIngestWork['fail']>[1],
  ): Promise<void> {
    return this.of(owner.jobId).fail(owner, failure);
  }

  async complete(
    owner: LeaseOwner,
    result: DocIngestResultRequest,
  ): Promise<void> {
    await this.of(owner.jobId).complete(owner, result);
    const { outcome } = result;
    if (outcome.state === 'ready')
      await this.deps.entered(owner.jobId, outcome.document.id);
  }

  readonly step: DocIngestWork['step'] = (owner, request) =>
    this.deps.docs.step(owner, request);

  readonly fileOf: DocIngestWork['fileOf'] = (owner) =>
    this.deps.docs.fileOf(owner);

  readonly list: DocIngestWork['list'] = (owner, request) =>
    this.deps.docs.list(owner, request);

  readonly adopt: DocIngestWork['adopt'] = (owner, audio) =>
    this.deps.docs.adopt(owner, audio);
}
