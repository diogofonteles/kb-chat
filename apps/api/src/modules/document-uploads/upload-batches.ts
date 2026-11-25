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

export const isWorking = (record: DocumentUploadRecord): boolean =>
  WORKING_STATES.has(record.state) && record.lease !== null;

const sum = (values: readonly number[]): number =>
  values.reduce((total, value) => total + value, 0);

const itemsOf = (
  records: readonly DocumentUploadRecord[],
  id: string,
): DocumentUploadRecord[] => records.filter((one) => one.batch?.id === id);

/** An inclusion's ceiling and what its items spent so far; null when nothing is in it. */
export function batchOf(
  records: readonly DocumentUploadRecord[],
  id: string,
): DocumentBatch | null {
  const items = itemsOf(records, id);
  const capUsd = items[0]?.batch?.capUsd;
  if (capUsd === undefined) return null;
  return { id, capUsd, spentUsd: sum(items.map((one) => one.spentUsd)) };
}

/**
 * What `record` may still spend of its inclusion's ceiling: the ceiling less what was spent
 * and what the other items hold on the Mac now. No inclusion: nothing limits it here.
 */
export function batchLeftUsd(
  records: readonly DocumentUploadRecord[],
  record: DocumentUploadRecord,
): number {
  if (!record.batch) return Number.POSITIVE_INFINITY;
  const items = itemsOf(records, record.batch.id);
  const held = items
    .filter((one) => one.id !== record.id && isWorking(one))
    .map((one) => one.lease?.budgetUsd ?? 0);
  const spent = items.map((one) => one.spentUsd);
  return record.batch.capUsd - sum(spent) - sum(held);
}
