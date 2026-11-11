import type { DatabaseSync } from 'node:sqlite';
import type { LeaseOwner } from '../../ports/media-store.js';
import type {
  WaveformRecord,
  WaveformStorePort,
} from '../../ports/waveform-store.js';
import { inTransaction } from './media-database.js';
import { closeLease } from './sqlite-leases.js';

/** Waveforms in the media database (KBC-066, migration media-edits). */
export class SqliteWaveformStore implements WaveformStorePort {
  constructor(private readonly db: DatabaseSync) {}

  waveformOf(mediaId: string): WaveformRecord | null {
    const row = this.db
      .prepare('SELECT version, peaks FROM media_waveforms WHERE media_id = ?')
      .get(mediaId);
    if (!row) return null;
    const { peaks } = row;
    return {
      mediaId,
      version: Number(row['version']),
      peaks: peaks instanceof Uint8Array ? peaks : new Uint8Array(),
    };
  }

  heldJob(owner: LeaseOwner): string | null {
    const row = this.db
      .prepare(
        `SELECT media_id FROM jobs WHERE id = ? AND lease_id = ? AND worker = ?
           AND status = 'leased' AND kind = 'waveform'`,
      )
      .get(owner.jobId, owner.leaseId, owner.worker);
    return row ? String(row['media_id']) : null;
  }

  complete(input: {
    owner: LeaseOwner;
    waveform: WaveformRecord;
    elapsedMs: number;
    now: Date;
  }): boolean {
    const at = input.now.toISOString();
    return inTransaction(this.db, () => {
      if (
        !closeLease(this.db, input.owner, { status: 'done', error: null, at })
      )
        return false;
      const { mediaId, version, peaks } = input.waveform;
      this.db
        .prepare(
          `INSERT OR REPLACE INTO media_waveforms (media_id, version, peaks, elapsed_ms,
             created_at) VALUES (?, ?, ?, ?, ?)`,
        )
        .run(mediaId, version, peaks, input.elapsedMs, at);
      return true;
    });
  }

  gaveUp(mediaId: string, version: number): boolean {
    const row = this.db
      .prepare(
        `SELECT
           EXISTS (SELECT 1 FROM jobs WHERE media_id = ? AND kind = 'waveform'
                   AND status IN ('failed', 'dead') AND detector_version = ?) AS gave_up,
           EXISTS (SELECT 1 FROM jobs WHERE media_id = ? AND kind = 'waveform'
                   AND status IN ('queued', 'leased')) AS waiting`,
      )
      .get(mediaId, version, mediaId);
    return Number(row?.['gave_up']) === 1 && Number(row?.['waiting']) === 0;
  }

  queueBackfill(input: {
    version: number;
    jobId: string;
    now: Date;
  }): string | null {
    const at = input.now.toISOString();
    return inTransaction(this.db, () => {
      if (this.hasWaveformWaiting()) return null;
      const mediaId = this.oldestWithout(input.version);
      if (!mediaId) return null;
      this.db
        .prepare(
          `INSERT INTO jobs (id, media_id, kind, status, created_at, updated_at,
             detector_version)
           VALUES (?, ?, 'waveform', 'queued', ?, ?, ?)`,
        )
        .run(input.jobId, mediaId, at, at, input.version);
      return mediaId;
    });
  }

  private hasWaveformWaiting(): boolean {
    return (
      this.db
        .prepare(
          `SELECT 1 FROM jobs WHERE kind = 'waveform'
             AND status IN ('queued', 'leased') LIMIT 1`,
        )
        .get() !== undefined
    );
  }

  private oldestWithout(version: number): string | null {
    const row = this.db
      .prepare(
        `SELECT id FROM media m WHERE status = 'ready' AND parent_media_id IS NULL
           AND NOT EXISTS (SELECT 1 FROM media_waveforms w
                           WHERE w.media_id = m.id AND w.version = ?)
           AND NOT EXISTS (SELECT 1 FROM jobs j WHERE j.media_id = m.id
                           AND j.kind = 'waveform' AND j.status IN ('failed', 'dead')
                           AND j.detector_version = ?)
         ORDER BY created_at, id LIMIT 1`,
      )
      .get(version, version);
    return row ? String(row['id']) : null;
  }
}
