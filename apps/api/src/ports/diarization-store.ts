import type { SpeakerTurn } from '@kb-chat/contracts';
import type { JobStatus, LeaseOwner } from './media-store.js';

/** One separation as stored (ADR 0029 §1), with what was derived from its raw turns. */
export interface NewDiarization {
  readonly id: string;
  readonly mediaId: string;
  /** The transcript the voices were derived on (the current one when it arrived, BR-3). */
  readonly transcriptId: string;
  readonly engine: string;
  readonly model: string;
  /** The worker's parameters, as JSON. */
  readonly parameters: string;
  readonly parametersVersion: string;
  readonly requestedVoices: number | null;
  readonly voiceCount: number;
  readonly elapsedMs: number;
  /** The raw JSON file, relative to the media directory. */
  readonly rawPath: string;
  readonly derivationVersion: number;
  readonly turns: readonly SpeakerTurn[];
  /** The voice of each segment of that transcript, in its order (null: none found). */
  readonly segmentVoices: readonly (number | null)[];
  /** The voice of each word of that transcript, in its order. */
  readonly wordVoices: readonly (number | null)[];
  /** The names carried over from the previous separation (KBC-065 FR-5). */
  readonly labels: readonly CarriedLabel[];
  /** The previous separation had names: this one waits for a person (BR-5). */
  readonly namesPending: boolean;
}

/** A name a new separation takes from the one before. */
export interface CarriedLabel {
  readonly voice: number;
  readonly speakerId: string | null;
  readonly audience: boolean;
}

/** A stored separation, without its turns and voices. */
export interface DiarizationSummary {
  readonly id: string;
  readonly mediaId: string;
  readonly version: number;
  readonly transcriptId: string;
  readonly requestedVoices: number | null;
  readonly voiceCount: number;
  readonly rawPath: string;
  readonly derivationVersion: number;
  readonly createdAt: string;
  readonly namesPending: boolean;
}

/** The newest diarize job of an item: its status and the hint it carries. */
export interface DiarizeJobRecord {
  readonly status: JobStatus;
  readonly voices: number | null;
}

/**
 * Voice separations of the media (KBC-064), in the media database. Completing a diarize job
 * and storing its result is one transaction; no voice print is ever stored (BR-1).
 */
export interface DiarizationStorePort {
  /** Queues a separation; false when one is already queued or running. */
  requestDiarization(input: {
    readonly mediaId: string;
    readonly jobId: string;
    readonly voices: number | null;
    readonly now: Date;
  }): boolean;
  /**
   * The item and the voices hint of the diarize job the owner holds now; null when it holds
   * no such job.
   */
  heldDiarization(
    owner: LeaseOwner,
  ): { readonly mediaId: string; readonly voices: number | null } | null;
  /** Closes the lease and stores the separation as the item's newest version. */
  completeDiarize(input: {
    readonly owner: LeaseOwner;
    readonly diarization: NewDiarization;
    readonly now: Date;
  }): boolean;
  /** The newest diarize job of an item; null when none was ever made. */
  latestJob(mediaId: string): DiarizeJobRecord | null;
  /** The newest separation of an item; null before the first. */
  latest(mediaId: string): DiarizationSummary | null;
  turns(diarizationId: string): SpeakerTurn[];
  segmentVoices(diarizationId: string): (number | null)[];
  wordVoices(diarizationId: string): (number | null)[];
}
