import type {
  JobCuts,
  MediaFailure,
  MediaJobKind,
  MediaKind,
  MediaStatus,
  TranscriptConfidence,
  TranscriptProvider,
  TranscriptionHold,
  TranscriptionRoute,
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
  /** Who made the current transcript (KBC-037); null before the first. */
  readonly provider: TranscriptProvider | null;
  /** Who the newest transcribe job is for (KBC-037). */
  readonly route: TranscriptionRoute;
  /** Why Groq left the newest job to the transcriber (KBC-037 FR-4). */
  readonly hold: TranscriptionHold | null;
}

/** The authorship column the app had before KBC-049, still written for a rollback. */
export type LegacyAuthorship = 'mestre-laercio' | 'outros-autores';

/** Where a track item sits in its recording; bounds are real (KBC-068). */
export interface TrackLink {
  readonly parentId: string;
  readonly startMs: number;
  readonly endMs: number;
  /** Among the approved tracks; null once it left the edit. */
  readonly ordinal: number | null;
  /** Guards a person's write (KBC-073 BR-10). */
  readonly version: number;
  /** Which cut is the file (KBC-073 BR-3). */
  readonly fileVersion: number;
}

/** A media item as stored (ADR 0022): the catalog row the module turns into the contract. */
export interface MediaRecord {
  readonly id: string;
  readonly topic: string;
  readonly title: string;
  /** One of its collection's authors (KBC-049), or null for "Outros autores". */
  readonly author: string | null;
  /** Who uploaded it: only they may send its file. */
  readonly ownerPrincipal: string;
  readonly fileName: string;
  /** Bytes announced for the upload. */
  readonly uploadBytes: number;
  /** The file's SHA-256 as announced (KBC-035); null for what came before it, or a track. */
  readonly sourceSha256: string | null;
  readonly status: MediaStatus;
  readonly progress: number | null;
  readonly failure: MediaFailure | null;
  readonly durationMs: number | null;
  /** Bytes of the converted audio. */
  readonly bytes: number | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly transcription: TranscriptionRecord;
  /** Only a track item has one (KBC-068). */
  readonly track: TrackLink | null;
  /** A track that left the edit (BR-5). */
  readonly archivedAt: string | null;
}

/** A media item with its kind, for the library (KBC-051). */
export interface LibraryRecord extends MediaRecord {
  readonly kind: MediaKind;
}

export interface NewMedia {
  readonly id: string;
  readonly topic: string;
  readonly title: string;
  readonly author: string | null;
  /** The pre-KBC-049 column: `mestre-laercio` only for the author of that id (ADR 0030 §4). */
  readonly legacyAuthorship: LegacyAuthorship;
  readonly ownerPrincipal: string;
  readonly fileName: string;
  readonly uploadBytes: number;
  /** The file's SHA-256 (KBC-035); absent when sent without it. */
  readonly sourceSha256?: string | null;
  /** What it should take once converted, for the quota until then (KBC-035 FR-3). */
  readonly estimatedBytes?: number | null;
  readonly now: Date;
}

/** An item's details after an edit (KBC-050); the file and its jobs are not touched. */
export interface MediaEdit {
  readonly mediaId: string;
  readonly title: string;
  readonly topic: string;
  readonly author: string | null;
  readonly legacyAuthorship: LegacyAuthorship;
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
  /** A diarize job's hint: how many voices the person announced (KBC-064 BR-4). */
  readonly voices: number | null;
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
  /**
   * A worker holding a lease gets nothing more (ADR 0023: one job at a time per paired
   * transcriber, so a leaked token cannot drain the queue's audio).
   */
  readonly oneAtATime?: boolean;
  /**
   * Which transcriptions it may take (KBC-037): a paired transcriber's (the default) or the
   * ones routed to Groq, which only the VM worker leases.
   */
  readonly transcribeRoute?: TranscriptionRoute;
}

export interface Heartbeat extends LeaseOwner {
  readonly progress: number | null;
  /** A transcription's cuts (KBC-072 FR-3). */
  readonly cuts?: JobCuts;
  readonly now: Date;
  readonly leaseMs: number;
}

export interface TranscodeResult extends LeaseOwner {
  readonly rendition: MediaRendition;
  readonly durationMs: number;
  /** The item is ready: its transcription is queued with this job id (KBC-036 FR-1). */
  readonly transcribeJobId: string;
  /** …and its silences are measured with this job id (KBC-044 FR-1). */
  readonly silencesJobId: string;
  readonly waveformJobId: string;
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
  /** Items whose transcription was given up: their FLAC serves nothing now (not silences). */
  readonly transcriptionsGivenUp: readonly string[];
}

/**
 * The media catalog and its job queue, in one transactional store (ADR 0022). Every
 * method that changes a job and its media item does both in one transaction.
 */
export interface MediaStorePort {
  createMedia(media: NewMedia): MediaRecord;
  /** The items of a collection sent from this file, newest first (KBC-035 BR-2). */
  findBySource(topic: string, sha256: string): MediaRecord[];
  /** The recordings sent from this file, in any collection (KBC-091). */
  findEverywhere(sha256: string): MediaRecord[];
  /** A person's converted space: real once converted, the estimate until then (BR-1). */
  usedBytes(principal: string): number;
  /** A part arrived: the 24 h of an upload count from the last one (KBC-035 BR-3). */
  touchUpload(mediaId: string, now: Date): void;
  getMedia(id: string): MediaRecord | null;
  listMedia(topic: string): MediaRecord[];
  /** The collections holding media by this author (the legacy seed, KBC-049 BR-4). */
  topicsWithAuthor(author: string): string[];
  /** How many tracks the recording has in force. */
  trackTotal(parentId: string): number;
  /** Every media item, any collection (the library filters what the person sees). */
  listLibrary(): LibraryRecord[];
  /** The upload arrived: the item waits in the queue with a new `transcode` job. */
  markUploaded(input: {
    readonly mediaId: string;
    readonly jobId: string;
    readonly now: Date;
  }): MediaRecord;
  getRendition(mediaId: string): MediaRendition | null;
  /** Writes the item's details; null when it no longer exists. */
  editMedia(edit: MediaEdit): MediaRecord | null;
  /** Removes the item, its renditions and jobs; false when it did not exist. */
  deleteMedia(id: string): boolean;
  /** A failed item goes back to the queue with a fresh attempt count. */
  retryMedia(input: {
    readonly mediaId: string;
    readonly now: Date;
  }): MediaRecord;

  leaseJob(request: LeaseRequest): LeasedJob | null;
  /** What a job is; null when it does not exist (anymore). */
  kindOfJob(jobId: string): MediaJobKind | null;
  /** The media item a job converts; null when the job does not exist (anymore). */
  mediaOfJob(jobId: string): string | null;
  /** False when the lease is no longer this worker's (expired, re-leased, removed). */
  heartbeat(beat: Heartbeat): boolean;
  /**
   * The rendition is in place: the item is ready and its transcription is queued, unless
   * the person asked for none (KBC-072 BR-1).
   */
  completeTranscode(result: TranscodeResult): boolean;
  /** The person unticked "Transcrever" on this upload. */
  skipsTranscription(mediaId: string): boolean;
  failJob(failure: JobFailure): boolean;
  /** Expired leases go back to the queue, or fail after `maxAttempts`. */
  reapExpired(input: {
    readonly now: Date;
    readonly maxAttempts: number;
  }): ReapResult;
  /** Items with no part since before `olderThan` fail as abandoned; their ids (BR-3). */
  abandonUploads(input: {
    readonly olderThan: Date;
    readonly now: Date;
  }): string[];
  close(): void;
}
