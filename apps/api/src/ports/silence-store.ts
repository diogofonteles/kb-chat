import type { SilenceInterval } from '@kb-chat/contracts';
import type { LeaseOwner } from './media-store.js';

/** The parameters a map was measured with (FR-1); `version` names the set. */
export interface SilenceDetectorParams {
  readonly version: number;
  readonly noiseDb: number;
  readonly minSilenceMs: number;
}

/** A media item's current silence map (ADR 0025 §3), pauses in order. */
export interface SilenceMapRecord {
  readonly mediaId: string;
  readonly detector: SilenceDetectorParams;
  readonly intervals: readonly SilenceInterval[];
  readonly createdAt: string;
}

export interface NewSilenceMap {
  readonly mediaId: string;
  readonly detector: SilenceDetectorParams;
  readonly intervals: readonly SilenceInterval[];
  readonly elapsedMs: number;
}

/**
 * Silence maps in the media database (KBC-044): one per media item, measured on its audio
 * rendition, replaced as a whole. Ending a silences job and storing its map is one
 * transaction.
 */
export interface SilenceStorePort {
  mapOf(mediaId: string): SilenceMapRecord | null;
  /** The media item of a silences job `owner` still holds; null otherwise. */
  heldSilencesJob(owner: LeaseOwner): string | null;
  /** Ends the job as done and replaces the item's map; false when the lease is gone. */
  completeSilences(input: {
    readonly owner: LeaseOwner;
    readonly map: NewSilenceMap;
    readonly now: Date;
  }): boolean;
  /**
   * Backfill (FR-2): when no silences job is queued or leased, queues one with `jobId`
   * for the oldest ready item without a map of `detectorVersion` (and never given up);
   * the item's id, or null when nothing was queued.
   */
  queueBackfill(input: {
    readonly detectorVersion: number;
    readonly jobId: string;
    readonly now: Date;
  }): string | null;
}
