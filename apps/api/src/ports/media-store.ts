import type {
  MediaAuthorship,
  MediaFailure,
  MediaJobKind,
  MediaStatus,
  TranscriptConfidence,
} from '@kb-chat/contracts';

/** Where a job is in the queue (ADR 0022 §2). */
export type JobStatus = 'queued' | 'leased' | 'done' | 'failed' | 'dead';

/** An item's transcription as stored: its newest transcribe job and current transcript. */
export interface TranscriptionRecord {
  /** The newest transcribe job's status; null when none was ever made. */
  readonly jobStatus: JobStatus | null;
  /** The current (newest) transcript's version and confidence; null before the first. */
  readonly version: number | null;
  readonly confidence: TranscriptConfidence | null;
}

/** A media item as stored (ADR 0022): the catalog row the module turns into the contract. */
export interface MediaRecord {
  readonly id: string;
  readonly topic: string;
  readonly title: string;
  readonly authorship: MediaAuthorship;
  /** Who uploaded it: only they may send its file. */
  readonly ownerPrincipal: string;
  readonly fileName: string;
  /** Bytes announced for the upload. */
  readonly uploadBytes: number;
  readonly status: MediaStatus;
  readonly progress: number | null;
  readonly failure: MediaFailure | null;
  readonly durationMs: number | null;
  /** Bytes of the converted audio. */
  readonly bytes: number | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly transcription: TranscriptionRecord;
}

export interface NewMedia {
  readonly id: string;
  readonly topic: string;
  readonly title: string;
  readonly authorship: MediaAuthorship;
  readonly ownerPrincipal: string;
  readonly fileName: string;
  readonly uploadBytes: number;
  readonly now: Date;
}

/** A playable file of a media item (ADR 0022: `media_files`). */
export interface MediaRendition {
  readonly mediaId: string;
  readonly rendition: 'audio';
  /** Relative to the media directory. */
  readonly path: string;
  readonly bytes: number;
  readonly mime: string;
}

/** A job the worker holds: `leaseId` names this lease. */
export interface LeasedJob {
  readonly id: string;
  readonly leaseId: string;
  readonly kind: MediaJobKind;
  readonly mediaId: string;
  readonly attempt: number;
}

export interface LeaseOwner {
  readonly jobId: string;
  readonly leaseId: string;
  readonly worker: string;
}

export interface LeaseRequest {
  readonly kinds: readonly MediaJobKind[];
  readonly worker: string;
  readonly now: Date;
  readonly leaseMs: number;
}

export interface Heartbeat extends LeaseOwner {
  readonly progress: number | null;
  readonly now: Date;
  readonly leaseMs: number;
}

export interface TranscodeResult extends LeaseOwner {
  readonly rendition: MediaRendition;
  readonly durationMs: number;
  /** The item is ready: its transcription is queued with this job id (KBC-036 FR-1). */
  readonly transcribeJobId: string;
  readonly now: Date;
}

export interface JobFailure extends LeaseOwner {
  readonly failure: 'invalid-audio' | 'conversion-failed';
  readonly detail: string;
  readonly now: Date;
  /** Leases a job may take before it is given up (1 + retries, KBC-034 BR-5). */
  readonly maxAttempts: number;
}

/** What the janitor did: jobs given back to the queue and jobs given up. */
export interface ReapResult {
  readonly requeued: number;
  readonly failed: number;
}

/**
 * The media catalog and its job queue, in one transactional store (ADR 0022). Every
 * method that changes a job and its media item does both in one transaction.
 */
export interface MediaStorePort {
  createMedia(media: NewMedia): MediaRecord;
  getMedia(id: string): MediaRecord | null;
  listMedia(topic: string): MediaRecord[];
  /** The upload arrived: the item waits in the queue with a new `transcode` job. */
  markUploaded(input: {
    readonly mediaId: string;
    readonly jobId: string;
    readonly now: Date;
  }): MediaRecord;
  getRendition(mediaId: string): MediaRendition | null;
  /** Removes the item, its renditions and jobs; false when it did not exist. */
  deleteMedia(id: string): boolean;
  /** A failed item goes back to the queue with a fresh attempt count. */
  retryMedia(input: {
    readonly mediaId: string;
    readonly now: Date;
  }): MediaRecord;

  leaseJob(request: LeaseRequest): LeasedJob | null;
  /** The media item a job converts; null when the job does not exist (anymore). */
  mediaOfJob(jobId: string): string | null;
  /** False when the lease is no longer this worker's (expired, re-leased, removed). */
  heartbeat(beat: Heartbeat): boolean;
  /** The rendition is in place: the item is ready and its transcription is queued. */
  completeTranscode(result: TranscodeResult): boolean;
  failJob(failure: JobFailure): boolean;
  /** Expired leases go back to the queue, or fail after `maxAttempts`. */
  reapExpired(input: {
    readonly now: Date;
    readonly maxAttempts: number;
  }): ReapResult;
  /** Items still `uploading` since before `olderThan` fail as abandoned; their ids. */
  abandonUploads(input: {
    readonly olderThan: Date;
    readonly now: Date;
  }): string[];
  close(): void;
}
