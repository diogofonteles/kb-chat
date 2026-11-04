import type { LeaseOwner } from './media-store.js';

/** A recording's peaks: one byte per peak (ADR 0029 §4). */
export interface WaveformRecord {
  readonly mediaId: string;
  readonly version: number;
  readonly peaks: Uint8Array;
}

/**
 * Waveforms in the media database (KBC-066): one per recording, measured on its audio
 * rendition. Ending a waveform job and storing its peaks is one transaction.
 */
export interface WaveformStorePort {
  waveformOf(mediaId: string): WaveformRecord | null;
  /** The media item of a waveform job `owner` still holds; null otherwise. */
  heldJob(owner: LeaseOwner): string | null;
  /** Ends the job as done and replaces the peaks; false when the lease is gone. */
  complete(input: {
    readonly owner: LeaseOwner;
    readonly waveform: WaveformRecord;
    readonly elapsedMs: number;
    readonly now: Date;
  }): boolean;
  /** The queue gave up on this item at `version` and nothing is waiting to try again. */
  gaveUp(mediaId: string, version: number): boolean;
  /**
   * Backfill: when no waveform job is queued or leased, queues one for the oldest ready item
   * without peaks of `version` (and never given up); the item's id, or null.
   */
  queueBackfill(input: {
    readonly version: number;
    readonly jobId: string;
    readonly now: Date;
  }): string | null;
}
