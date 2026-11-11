import type { ActAsAuditEntry } from '@kb-chat/contracts';

/**
 * The act-as audit (KBC-060, ADR 0027): append-only, every line written before the answer
 * leaves (NFR-2), kept 12 months. Nothing in the API rewrites or deletes a line.
 */
export interface ActAsAuditPort {
  append(entry: ActAsAuditEntry): Promise<void>;
  /** Every line since `since`, oldest first. */
  since(since: Date): Promise<ActAsAuditEntry[]>;
  /** Drops the months entirely older than `before` (the 12-month retention). */
  prune(before: Date): Promise<number>;
}
