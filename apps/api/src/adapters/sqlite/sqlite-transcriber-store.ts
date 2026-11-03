import type { DatabaseSync, SQLOutputValue } from 'node:sqlite';
import { z } from 'zod';
import { mediaJobKindSchema } from '@kb-chat/contracts';
import {
  TRANSCRIBER_LEASE_PREFIX,
  leaseNameOf,
  type NewTranscriber,
  type TranscriberRecord,
  type TranscriberStorePort,
} from '../../ports/transcriber-store.js';
import { inTransaction } from './media-database.js';

type Row = Record<string, SQLOutputValue>;

const kindsSchema = z.array(mediaJobKindSchema);

/** A transcriber with the item it holds now, if any (the newest lease). */
const COLUMNS = `t.id, t.name, t.kinds, t.created_at, t.last_seen_at,
  (SELECT j.media_id FROM jobs j WHERE j.worker = '${TRANSCRIBER_LEASE_PREFIX}' || t.id
     AND j.status = 'leased' ORDER BY j.updated_at DESC LIMIT 1) AS job_media,
  (SELECT m.title FROM jobs j JOIN media m ON m.id = j.media_id
     WHERE j.worker = '${TRANSCRIBER_LEASE_PREFIX}' || t.id AND j.status = 'leased'
     ORDER BY j.updated_at DESC LIMIT 1) AS job_title`;

function toRecord(row: Row): TranscriberRecord {
  const mediaId = row['job_media'];
  return {
    id: String(row['id']),
    name: String(row['name']),
    kinds: kindsSchema.parse(JSON.parse(String(row['kinds']))),
    createdAt: String(row['created_at']),
    lastSeenAt:
      row['last_seen_at'] === null ? null : String(row['last_seen_at']),
    currentJob:
      typeof mediaId === 'string'
        ? { mediaId, title: String(row['job_title']) }
        : null,
  };
}

/** Paired transcribers in the media database (ADR 0023 §2). */
export class SqliteTranscriberStore implements TranscriberStorePort {
  constructor(private readonly db: DatabaseSync) {}

  pair(transcriber: NewTranscriber): TranscriberRecord {
    this.db
      .prepare(
        `INSERT INTO transcribers (id, name, kinds, token_hash, created_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        transcriber.id,
        transcriber.name,
        JSON.stringify(transcriber.kinds),
        transcriber.tokenHash,
        transcriber.createdBy,
        transcriber.now.toISOString(),
      );
    const paired = this.byId(transcriber.id);
    if (!paired) throw new Error(`transcriber ${transcriber.id} was not saved`);
    return paired;
  }

  list(): TranscriberRecord[] {
    return this.db
      .prepare(
        `SELECT ${COLUMNS} FROM transcribers t WHERE t.revoked_at IS NULL
         ORDER BY t.created_at, t.id`,
      )
      .all()
      .map(toRecord);
  }

  byTokenHash(tokenHash: string): TranscriberRecord | null {
    const row = this.db
      .prepare(
        `SELECT ${COLUMNS} FROM transcribers t
         WHERE t.token_hash = ? AND t.revoked_at IS NULL`,
      )
      .get(tokenHash);
    return row ? toRecord(row) : null;
  }

  touch(input: { id: string; now: Date }): void {
    this.db
      .prepare('UPDATE transcribers SET last_seen_at = ? WHERE id = ?')
      .run(input.now.toISOString(), input.id);
  }

  revoke(input: { id: string; now: Date }): boolean {
    const at = input.now.toISOString();
    return inTransaction(this.db, () => {
      const changed = this.db
        .prepare(
          `UPDATE transcribers SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL`,
        )
        .run(at, input.id).changes;
      if (changed !== 1) return false;
      // Its work goes back to the queue now, not when the lease would have expired.
      this.db
        .prepare(
          `UPDATE jobs SET status = 'queued', lease_id = NULL, lease_until = NULL,
             worker = NULL, updated_at = ? WHERE worker = ? AND status = 'leased'`,
        )
        .run(at, leaseNameOf(input.id));
      return true;
    });
  }

  private byId(id: string): TranscriberRecord | null {
    const row = this.db
      .prepare(`SELECT ${COLUMNS} FROM transcribers t WHERE t.id = ?`)
      .get(id);
    return row ? toRecord(row) : null;
  }
}
