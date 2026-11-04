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
  /** Replaces the draft with `tracks`: a changed proposal stops being one (KBC-067 BR-6). */
  save(
    write: EditWrite & {
      readonly tracks: readonly EditTrack[];
      readonly step: EditStep;
      readonly transcriptVersion: number | null;
    },
  ): number | null;
  /** The draft becomes the approved tracks, replacing the previous approval (BR-9). */
  approve(
    write: EditWrite & {
      readonly transcriptVersion: number | null;
      /** Runs in the same transaction, on the new approved tracks (KBC-068 FR-1). */
      readonly alongside?: () => void;
    },
  ): number | null;
  /** Back to the draft and step 3; listeners keep the approved tracks (BR-9). */
  reopen(write: EditWrite & { readonly alongside?: () => void }): number | null;
  approved(mediaId: string): ApprovedTrack[];
  /** Which of `ids` are tracks of another recording, in its draft or approved (FR-1). */
  foreignIds(mediaId: string, ids: readonly string[]): string[];
}
