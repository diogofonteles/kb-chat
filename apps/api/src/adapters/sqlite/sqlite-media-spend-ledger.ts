import type { DatabaseSync } from 'node:sqlite';
import type {
  MediaSpendKind,
  MediaSpendLedgerPort,
  MediaSpendOutcome,
} from '../../ports/media-spend-ledger.js';
import { inTransaction } from './media-database.js';

/** An open reservation counts in full; a closed one counts only what it spent. */
const USED_SINCE = `SELECT coalesce(sum(
    CASE status WHEN 'reserved' THEN max(reserved_usd, spent_usd) ELSE spent_usd END
  ), 0) AS used
  FROM media_spend WHERE created_at >= ?`;

/** The media monthly spend ledger in `media.db` (ADR 0022 §7, KBC-067 BR-3). */
export class SqliteMediaSpendLedger implements MediaSpendLedgerPort {
  constructor(private readonly db: DatabaseSync) {}

  reserve(input: {
    id: string;
    kind: MediaSpendKind;
    mediaId: string;
    principal: string;
    usd: number;
    capUsd: number;
    since: Date;
    now: Date;
  }): boolean {
    return inTransaction(this.db, () => {
      if (this.usedSince(input.since) + input.usd > input.capUsd) return false;
      this.db
        .prepare(
          `INSERT INTO media_spend (id, kind, media_id, principal, reserved_usd, status,
             created_at) VALUES (?, ?, ?, ?, ?, 'reserved', ?)`,
        )
        .run(
          input.id,
          input.kind,
          input.mediaId,
          input.principal,
          input.usd,
          input.now.toISOString(),
        );
      return true;
    });
  }

  usedSince(since: Date): number {
    const row = this.db.prepare(USED_SINCE).get(since.toISOString());
    return Number(row?.['used'] ?? 0);
  }

  close(input: {
    id: string;
    spentUsd: number;
    outcome: MediaSpendOutcome;
    now: Date;
  }): void {
    this.db
      .prepare(
        `UPDATE media_spend SET status = ?, spent_usd = ?, settled_at = ?
         WHERE id = ? AND status = 'reserved'`,
      )
      .run(input.outcome, input.spentUsd, input.now.toISOString(), input.id);
  }
}
