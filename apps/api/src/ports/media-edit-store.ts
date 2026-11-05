import type {
  ApprovedTrack,
  EditStatus,
  EditStep,
  EditTrack,
} from '@kb-chat/contracts';

/** A recording's edit, without its tracks (ADR 0029 §4). */
export interface MediaEditRecord {
  readonly mediaId: string;
  readonly version: number;
  readonly status: EditStatus;
  readonly step: EditStep;
  readonly transcriptVersion: number | null;
}

/** Who writes, on which version: every write names the version it read (FR-10). */
export interface EditWrite {
  readonly mediaId: string;
  readonly expectedVersion: number;
  readonly principal: string;
  readonly now: Date;
}

/**
 * The edit of a recording (KBC-066): its version, step and status over the draft tracks of
 * `TrackProposalStorePort`, and the approved tracks. Every write is one transaction and
 * answers null when `expectedVersion` is no longer the current one.
 */
export interface MediaEditStorePort {
  edit(mediaId: string): MediaEditRecord | null;
  /**
   * Replaces the draft with `tracks`: a changed proposal stops being one (KBC-067 BR-6). What
   * goes is only what left `shownIds`, the draft the person saw: a failed run's tracks out of
   * sight stand for windows already paid, and its retry needs them (KBC-097).
   */
  save(
    write: EditWrite & {
      readonly tracks: readonly EditTrack[];
      readonly shownIds: readonly string[];
      readonly step: EditStep;
      readonly transcriptVersion: number | null;
    },
  ): number | null;
  /**
   * The draft becomes the approved tracks, replacing the previous approval (BR-9). Only
   * `trackIds`, what the person saw and the rules checked: a failed run's rows out of sight
   * go, or they would reach listeners over the tracks in view (KBC-094).
   */
  approve(
    write: EditWrite & {
      readonly trackIds: readonly string[];
      readonly transcriptVersion: number | null;
      /** Runs in the same transaction, on the new approved tracks (KBC-068 FR-1). */
      readonly alongside?: () => void;
    },
  ): number | null;
  /** Back to the draft and step 3; listeners keep the approved tracks (BR-9). */
  reopen(write: EditWrite & { readonly alongside?: () => void }): number | null;
  approved(mediaId: string): ApprovedTrack[];
  /** The draft's tracks whose title the AI wrote and no person touched (KBC-090). */
  proposedTrackIds(mediaId: string): ReadonlySet<string>;
  /** Those titles, rewritten at once; a change moves the edit's version. */
  rewriteProposedDraft(input: {
    readonly mediaId: string;
    readonly rewrite: (text: string, max: number) => string;
    readonly now: Date;
  }): void;
  /** The summaries the AI suggested and no person took yet. */
  rewriteSuggestedSummaries(
    mediaId: string,
    rewrite: (text: string, max: number) => string,
  ): void;
  /** Which of `ids` are tracks of another recording, in its draft or approved (FR-1). */
  foreignIds(mediaId: string, ids: readonly string[]): string[];
}
