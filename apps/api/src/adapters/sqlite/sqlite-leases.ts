import type { DatabaseSync } from 'node:sqlite';
import type { LeaseOwner } from '../../ports/media-store.js';

/**
 * Ends a lease with an outcome, only while `owner` still holds it (ADR 0022 §2); false when
 * the lease expired, moved to another worker or the job is gone.
 */
export function closeLease(
  db: DatabaseSync,
  owner: LeaseOwner,
  outcome: { status: string; error: string | null; at: string },
): boolean {
  return (
    db
      .prepare(
        `UPDATE jobs SET status = ?, error = ?, lease_id = NULL, lease_until = NULL,
           updated_at = ?
         WHERE id = ? AND lease_id = ? AND worker = ? AND status = 'leased'`,
      )
      .run(
        outcome.status,
        outcome.error,
        outcome.at,
        owner.jobId,
        owner.leaseId,
        owner.worker,
      ).changes === 1
  );
}
