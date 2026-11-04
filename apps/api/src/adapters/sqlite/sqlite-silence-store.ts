import type { DatabaseSync } from 'node:sqlite';
import type { LeaseOwner } from '../../ports/media-store.js';
import type {
  NewSilenceMap,
  SilenceMapRecord,
  SilenceStorePort,
} from '../../ports/silence-store.js';
import { inTransaction } from './media-database.js';
import { closeLease } from './sqlite-leases.js';

/** Silence maps in the media database (KBC-044, migration silence-maps). */
export class SqliteSilenceStore implements SilenceStorePort {
  constructor(private readonly db: DatabaseSync) {}

  mapOf(mediaId: string): SilenceMapRecord | null {
    const map = this.db
      .prepare(
        `SELECT detector_version, noise_db, min_silence_ms, created_at
         FROM media_silence_maps WHERE media_id = ?`,
      )
      .get(mediaId);
    if (!map) return null;
    const intervals = this.db
      .prepare(
        `SELECT start_ms, end_ms FROM media_silences WHERE media_id = ?
         ORDER BY start_ms`,
      )
      .all(mediaId)
      .map((row) => ({
        startMs: Number(row['start_ms']),
        endMs: Number(row['end_ms']),
      }));
    return {
      mediaId,
      detector: {
        version: Number(map['detector_version']),
        noiseDb: Number(map['noise_db']),
        minSilenceMs: Number(map['min_silence_ms']),
      },
      intervals,
      createdAt: String(map['created_at']),
    };
  }

  heldSilencesJob(owner: LeaseOwner): string | null {
    const row = this.db
      .prepare(
        `SELECT media_id FROM jobs WHERE id = ? AND lease_id = ? AND worker = ?
           AND status = 'leased' AND kind = 'silences'`,
      )
      .get(owner.jobId, owner.leaseId, owner.worker);
    return row ? String(row['media_id']) : null;
  }

  completeSilences(input: {
    owner: LeaseOwner;
    map: NewSilenceMap;
    now: Date;
  }): boolean {
    const at = input.now.toISOString();
    return inTransaction(this.db, () => {
      if (
        !closeLease(this.db, input.owner, { status: 'done', error: null, at })
      )
        return false;
      this.replaceMap(input.map, at);
      return true;
    });
  }

  private replaceMap(map: NewSilenceMap, at: string): void {
    // The pauses go with the old map row (ON DELETE CASCADE).
    this.db
      .prepare('DELETE FROM media_silence_maps WHERE media_id = ?')
      .run(map.mediaId);
    this.db
      .prepare(
        `INSERT INTO media_silence_maps (media_id, rendition, detector_version, noise_db,
           min_silence_ms, interval_count, elapsed_ms, created_at)
         VALUES (?, 'audio', ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        map.mediaId,
        map.detector.version,
        map.detector.noiseDb,
        map.detector.minSilenceMs,
        map.intervals.length,
        map.elapsedMs,
        at,
      );
    const insert = this.db.prepare(
      'INSERT INTO media_silences (media_id, start_ms, end_ms) VALUES (?, ?, ?)',
    );
    for (const interval of map.intervals)
      insert.run(map.mediaId, interval.startMs, interval.endMs);
  }

  queueBackfill(input: {
    detectorVersion: number;
    jobId: string;
    now: Date;
  }): string | null {
    const at = input.now.toISOString();
    return inTransaction(this.db, () => {
      if (this.hasSilencesWaiting()) return null;
      const mediaId = this.oldestWithoutMap(input.detectorVersion);
      if (!mediaId) return null;
      this.db
        .prepare(
          `INSERT INTO jobs (id, media_id, kind, status, created_at, updated_at,
             detector_version)
           VALUES (?, ?, 'silences', 'queued', ?, ?, ?)`,
        )
        .run(input.jobId, mediaId, at, at, input.detectorVersion);
      return mediaId;
    });
  }

  /** A silences job is queued or running: the backfill waits for it (FR-2). */
  private hasSilencesWaiting(): boolean {
    return (
      this.db
        .prepare(
          `SELECT 1 FROM jobs WHERE kind = 'silences'
             AND status IN ('queued', 'leased') LIMIT 1`,
        )
        .get() !== undefined
    );
  }

  /**
   * The oldest ready item without a map of this version that this version never gave up
   * on (a newer detector version measures again what an older one could not).
   */
  private oldestWithoutMap(detectorVersion: number): string | null {
    const row = this.db
      .prepare(
        `SELECT id FROM media m WHERE status = 'ready' AND parent_media_id IS NULL
           AND NOT EXISTS (SELECT 1 FROM media_silence_maps s
                           WHERE s.media_id = m.id AND s.detector_version = ?)
           AND NOT EXISTS (SELECT 1 FROM jobs j WHERE j.media_id = m.id
                           AND j.kind = 'silences' AND j.status IN ('failed', 'dead')
                           AND j.detector_version = ?)
         ORDER BY created_at, id LIMIT 1`,
      )
      .get(detectorVersion, detectorVersion);
    return row ? String(row['id']) : null;
  }

  gaveUp(mediaId: string, detectorVersion: number): boolean {
    const row = this.db
      .prepare(
        `SELECT
           EXISTS (SELECT 1 FROM jobs WHERE media_id = ? AND kind = 'silences'
                   AND status IN ('failed', 'dead') AND detector_version = ?) AS gave_up,
           EXISTS (SELECT 1 FROM jobs WHERE media_id = ? AND kind = 'silences'
                   AND status IN ('queued', 'leased')) AS waiting`,
      )
      .get(mediaId, detectorVersion, mediaId);
    return Number(row?.['gave_up']) === 1 && Number(row?.['waiting']) === 0;
  }
}
