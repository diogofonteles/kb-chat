import type { DatabaseSync } from 'node:sqlite';
import type { TranscriptionHold } from '@kb-chat/contracts';
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

/**
 * A transcription Groq leaves goes back to the paired transcriber (KBC-037, ADR 0023 §7):
 * queued, unrouted, with the attempts it had before Groq took it, so Groq's own leases never
 * spend the Mac's. `hold` says why, when it is the cap (FR-4).
 */
export function groqBackToTranscriber(
  db: DatabaseSync,
  input: {
    readonly jobId: string;
    readonly hold: TranscriptionHold | null;
    readonly error: string | null;
    readonly at: string;
  },
): boolean {
  return (
    db
      .prepare(
        `UPDATE jobs SET status = 'queued', route = NULL, hold = ?, error = ?,
           attempts = coalesce(transcriber_attempts, attempts), transcriber_attempts = NULL,
           lease_id = NULL, lease_until = NULL, worker = NULL, updated_at = ?
         WHERE id = ? AND kind = 'transcribe' AND route = 'groq'`,
      )
      .run(input.hold, input.error, input.at, input.jobId).changes === 1
  );
}
