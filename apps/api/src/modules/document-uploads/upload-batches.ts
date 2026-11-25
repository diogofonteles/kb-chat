import type { DocumentBatch } from '@kb-chat/contracts';
import type { DocumentUploadRecord } from '../../ports/document-uploads.js';

/** Under this the Mac could not judge even one document: the item waits (KBC-009 R3). */
export const MIN_LEASE_USD = 0.005;

/** The states the Mac works in: a lease in one of them is live until it expires. */
export const WORKING_STATES: ReadonlySet<string> = new Set([
  'converting',
  'classifying',
  'mapping',
]);

/** The Mac has it now: its lease is live. One whose lease expired is nobody's. */
export const isWorking = (record: DocumentUploadRecord, now: Date): boolean =>
  WORKING_STATES.has(record.state) &&
  record.lease !== null &&
  Date.parse(record.lease.until) > now.getTime();

interface BatchTotals {
  readonly capUsd: number;
  readonly spentUsd: number;
  /** What the items the Mac has now may still spend. */
  readonly heldUsd: number;
}

/**
 * The inclusions' account at one moment, read once over all the items: what each spent
 * (items taken off the list included) and what it holds on the Mac now.
 */
export class BatchLedger {
  private readonly totals = new Map<string, BatchTotals>();

  constructor(
    records: readonly DocumentUploadRecord[],
    private readonly now: Date,
  ) {
    for (const record of records) {
      if (!record.batch) continue;
      const before = this.totals.get(record.batch.id);
      this.totals.set(record.batch.id, {
        capUsd: record.batch.capUsd,
        spentUsd: (before?.spentUsd ?? 0) + record.spentUsd,
        heldUsd: (before?.heldUsd ?? 0) + this.heldBy(record),
      });
    }
  }

  private heldBy(record: DocumentUploadRecord): number {
    return isWorking(record, this.now) ? (record.lease?.budgetUsd ?? 0) : 0;
  }

  viewOf(id: string): DocumentBatch | null {
    const totals = this.totals.get(id);
    return totals
      ? { id, capUsd: totals.capUsd, spentUsd: totals.spentUsd }
      : null;
  }

  /** The ceiling less what was really spent: what the person is told. */
  unspentOf(record: DocumentUploadRecord): number {
    const totals = record.batch && this.totals.get(record.batch.id);
    return totals ? totals.capUsd - totals.spentUsd : Number.POSITIVE_INFINITY;
  }

  /** What `record` may take now: less what the other items hold on the Mac too. */
  leftFor(record: DocumentUploadRecord): number {
    const totals = record.batch && this.totals.get(record.batch.id);
    if (!totals) return Number.POSITIVE_INFINITY;
    const others = totals.heldUsd - this.heldBy(record);
    return totals.capUsd - totals.spentUsd - others;
  }
}
