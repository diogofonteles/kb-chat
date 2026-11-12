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

/** How many jobs of a kind a transcriber could lease now. */
export interface TranscriberBacklog {
  readonly kind: MediaJobKind;
  readonly ready: number;
}

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
  /** Its access level (KBC-105), an id of its top-level collection's scale; null: none. */
  readonly level: string | null;
  /** A track with a level of its own: it no longer follows its recording's (KBC-106). */
  readonly levelOwn: boolean;
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
  /** Its access level, in a collection with levels (KBC-105 BR-1); none without a scale. */
  readonly level?: string | null;
  readonly now: Date;
}

/** An item's details after an edit (KBC-050); the file and its jobs are not touched. */
export interface MediaEdit {
  readonly mediaId: string;
  readonly title: string;
  readonly topic: string;
  readonly author: string | null;
  readonly legacyAuthorship: LegacyAuthorship;
  /** Its level after the edit; the tracks still at the old one follow it (KBC-105 BR-7). */
  readonly level: string | null;
  /**
   * How its tracks follow (KBC-106 BR-1): those of their own below the new level (`below`,
   * the scale's ids under it) go up to it; in another scale (`newScale`) every track takes
   * the new level and follows the recording again.
   */
  readonly tracks: {
    readonly below: readonly string[];
    readonly newScale: boolean;
  };
  readonly now: Date;
}

/** A track's level as a person set it (KBC-106 FR-1). */
export interface TrackLevelWrite {
  readonly mediaId: string;
  /** Its level now: its own, or its recording's when it follows. */
  readonly level: string | null;
  /** It holds a level of its own. */
  readonly own: boolean;
  readonly now: Date;
}

/** A published track a person may or may not hear (KBC-106 FR-2). */
export interface LiveTrackLevel {
  readonly mediaId: string;
  readonly level: string | null;
  readonly startMs: number;
  readonly endMs: number;
}

/** What an edit left: the item, and how many of its tracks changed level with it. */
export interface EditedMedia {
  readonly record: MediaRecord;
  readonly tracksRelevelled: number;
}

/** The first placement of a scaled collection's audios at its lowest level (ADR 0036 §4). */
export interface MediaLevelSeed {
  /** The top-level collection, whose scale it is. */
  readonly root: string;
  /** The collection and its sub-collections. */
  readonly topics: readonly string[];
  readonly level: string;
  readonly now: Date;
  /** A new scale seeds again; at start, a collection seeded before is left as it is. */
  readonly again: boolean;
}

/** One row's level, as a level change found it (KBC-108: what an undo puts back). */
export interface MediaLevelRow {
  readonly id: string;
  readonly level: string | null;
  /** A track's own level, as it was (KBC-106): an undo puts it back too. */
  readonly own?: boolean;
}

/** What an undo puts back: the level before, where the row still holds `written`. */
export interface MediaLevelRestore extends MediaLevelRow {
  readonly written: string | null;
}

/** A row a level change moved, with its collection (for the audit). */
export interface MovedMedia extends MediaLevelRow {
  readonly topic: string;
  /** What the change wrote when it is not the change's level: a track lifted (KBC-106). */
  readonly written?: string | null;
}

/** KBC-108: the audios of a scope at one level (or at any) move to another (or to none). */
export interface MediaRelevel {
  /** The collection and its sub-collections. */
  readonly topics: readonly string[];
  /** The level they hold now; absent: any level. */
  readonly from?: string;
  /** Their new level; null: no level (the scale is gone). */
  readonly to: string | null;
  /**
   * The scale after the change, lowest first: a track it would leave below its recording is
   * lifted to the recording's level and follows it (KBC-106 review M3).
   */
  readonly order?: readonly string[];
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
  editMedia(edit: MediaEdit): EditedMedia | null;
  /** KBC-106: a track's own level (or back to its recording's), its draft row following. */
  setTrackLevel(write: TrackLevelWrite): void;
  /** The live tracks of a recording with their levels and real bounds (KBC-106 FR-2). */
  liveTrackLevels(parentId: string): readonly LiveTrackLevel[];
  /**
   * Every level its tracks hold or are drafted at (archived and still being cut included,
   * KBC-106 decision): who does not hear all of them does not edit the recording.
   */
  trackLevelsUnder(recordingId: string): readonly (string | null)[];
  /** A media's level: null "Sem nível", undefined when there is no such media (KBC-106). */
  levelOf(mediaId: string): string | null | undefined;
  /** The own levels of a recording's tracks, one per track that has one (KBC-106 BR-1). */
  ownTrackLevels(parentId: string): readonly string[];
  /**
   * Places the audios with no level at the seed's level, once per collection unless `again`
   * (KBC-105 AC-10); the rows placed, or null when it had been seeded already.
   */
  seedLevel(seed: MediaLevelSeed): number | null;
  /**
   * KBC-106: the tracks a scale's new order leaves below their recordings take the
   * recording's level and follow it; the rows lifted, as they were, with what was written.
   */
  liftTracks(topics: readonly string[], order: readonly string[]): MovedMedia[];
  /** KBC-108: moves the audios of a level in one transaction; the rows moved, as they were. */
  relevel(change: MediaRelevel): MovedMedia[];
  /**
   * Puts rows back at the levels they had (the undo of `relevel`), in one transaction, only
   * where a row still holds what the change wrote (KBC-108 R1-3); the ids left as they are.
   */
  restoreLevels(rows: readonly MediaLevelRestore[]): string[];
  /** How many audios (recordings and tracks) of these collections hold each level. */
  countLevels(topics: readonly string[]): Readonly<Record<string, number>>;
  /** Removes the item, its renditions and jobs; false when it did not exist. */
  deleteMedia(id: string): boolean;
  /** A failed item goes back to the queue with a fresh attempt count. */
  retryMedia(input: {
    readonly mediaId: string;
    readonly now: Date;
  }): MediaRecord;

  leaseJob(request: LeaseRequest): LeasedJob | null;
  /** Whether this worker holds a lease of the queue now (one job at a time, ADR 0023). */
  holdsLease(worker: string): boolean;
  /**
   * Jobs only the Mac's transcriber takes that it could lease now, by kind, under the lease's
   * own predicate (KBC-114: the API starts it only for work it can do).
   */
  transcriberBacklog(): readonly TranscriberBacklog[];
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
