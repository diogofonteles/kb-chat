import type { TrackPreparation } from '@kb-chat/contracts';
import type { LeaseOwner, LegacyAuthorship } from './media-store.js';
import type { NewTranscript } from './transcript-store.js';

/** What a track of the approval will be, decided by the service (KBC-068 BR-5). */
export interface TrackPlan {
  readonly trackId: string;
  /** The item it keeps; null: a new one with `newMediaId`. */
  readonly keptMediaId: string | null;
  readonly newMediaId: string;
  /** Its bounds changed, or it is new: a cut is queued with this job id. */
  readonly cutJobId: string | null;
}

/** An approved track, with its item and where its cut is. */
export interface TrackItemRow {
  readonly trackId: string;
  readonly ordinal: number;
  readonly title: string;
  readonly startMs: number;
  readonly endMs: number;
  readonly answererVoice: number | null;
  readonly answererSpeakerId: string | null;
  readonly mediaId: string;
  readonly cut: boolean;
  /** Real bounds of the candidate, or of the published file when nothing was cut. */
  readonly realStartMs: number;
  readonly realEndMs: number;
}

/** What only the service knows about a track when it is published. */
export interface TrackDetails {
  readonly author: string | null;
  readonly legacyAuthorship: LegacyAuthorship;
  /** Null: a recording with no transcript yet. */
  readonly transcript: NewTranscript | null;
}

export type DetailsOf = (track: TrackItemRow) => TrackDetails;

export interface RecordedCut {
  readonly owner: LeaseOwner;
  readonly mediaId: string;
  readonly path: string;
  readonly bytes: number;
  readonly durationMs: number;
  readonly now: Date;
}

/** What a cut job asks of the worker; null when its track is gone. */
export interface CutOrder {
  readonly sourcePath: string;
  readonly startMs: number;
  readonly endMs: number;
}

/**
 * Track items (ADR 0029 §5): the rows `media_tracks` turn into, their cuts and their one
 * publication. Every write is one transaction, joining the caller's when there is one.
 */
export interface TrackItemStorePort {
  /** The live items of a recording: published and not archived. */
  published(
    parentId: string,
  ): readonly { mediaId: string; startMs: number; endMs: number }[];
  /** Creates the new items and the cuts of an approval just written to `media_tracks`. */
  plan(input: {
    readonly parentId: string;
    readonly plans: readonly TrackPlan[];
    readonly now: Date;
  }): void;
  /** Whether a cut is still on its way or failed: nothing to publish yet. */
  hasPendingCuts(parentId: string): boolean;
  /**
   * Stops what an approval started: its jobs, the items never published. The files of the
   * candidates are returned to remove; the publication in force stays (BR-1).
   */
  cancelPreparation(parentId: string): readonly string[];
  cutOrder(mediaId: string): CutOrder | null;
  /**
   * Closes the lease and keeps the candidate; the last one publishes, in the same transaction,
   * so no crash leaves a finished approval unpublished. Null when the lease was lost.
   */
  recordCut(
    cut: RecordedCut,
    detailsFor: (parentId: string) => DetailsOf,
  ): { readonly replaced: readonly string[] } | null;
  /**
   * Everything at once (FR-1, FR-6): files, real times, titles, authors, transcripts, positions,
   * bookmarks; items that left are archived. Returns the files replaced.
   */
  publish(input: {
    readonly parentId: string;
    readonly detailsOf: DetailsOf;
    readonly now: Date;
  }): readonly string[];
  /** The tracks approved now, for a new transcript or a move of the recording. */
  tracksOf(parentId: string): readonly TrackItemRow[];
  /** A new author for the tracks of a recording (BR-2). */
  setAuthor(input: {
    readonly mediaId: string;
    readonly author: string | null;
    readonly legacyAuthorship: LegacyAuthorship;
    readonly now: Date;
  }): void;
  preparation(parentId: string): TrackPreparation | null;
  /** Failed cuts go back to the queue with fresh attempts; how many. */
  retryCuts(parentId: string, now: Date): number;
  /** Every file of the recording's tracks, for a removal that takes them. */
  filesOf(parentId: string): readonly string[];
  /** Live track titles of a recording (KBC-073 FR-8: the removal lists them). */
  liveTitles(parentId: string): readonly string[];
}
