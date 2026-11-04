import type {
  MediaJobKind,
  TermVersion,
  TranscriptConfidence,
  TranscriptionTerms,
} from '@kb-chat/contracts';
import type { LeaseOwner } from './media-store.js';

/** A segment derived from the raw JSON, times in ms from the start of the track. */
export interface DerivedSegment {
  readonly startMs: number;
  readonly endMs: number;
  readonly text: string;
  readonly avgLogprob: number | null;
  readonly compressionRatio: number | null;
  readonly noSpeechProb: number | null;
}

export interface DerivedWord {
  /** Index of its segment in the derived list. */
  readonly segment: number;
  readonly startMs: number;
  readonly endMs: number;
  readonly text: string;
  readonly probability: number | null;
}

/** One transcription as stored (ADR 0022 §1 `transcripts`), with what was derived from it. */
export interface NewTranscript {
  readonly id: string;
  readonly mediaId: string;
  readonly provider: string;
  readonly model: string;
  /** The worker's parameters, as JSON. */
  readonly parameters: string;
  readonly parametersVersion: string;
  readonly termsVersion: number;
  readonly vad: 'applied' | 'skipped';
  readonly speechRatio: number;
  readonly elapsedMs: number;
  /** The raw JSON file, relative to the media directory. */
  readonly rawPath: string;
  readonly filterVersion: number;
  /** The confidence rules the verdict came from (ADR 0023 §6, versioned like the filter). */
  readonly confidenceVersion: number;
  readonly confidence: TranscriptConfidence;
  readonly wordCount: number;
  readonly removedWords: number;
  readonly lowWords: number;
  readonly segments: readonly DerivedSegment[];
  readonly words: readonly DerivedWord[];
}

/** A stored transcription, without its segments and words. */
export interface TranscriptSummary {
  readonly id: string;
  readonly mediaId: string;
  readonly version: number;
  /** The engine's model; on a track, the id of the recording's transcript it was cut from. */
  readonly model: string;
  readonly confidence: TranscriptConfidence;
  readonly vad: 'applied' | 'skipped';
  /** The term list it was made with (KBC-040 FR-4). */
  readonly termsVersion: number;
  readonly rawPath: string;
  readonly filterVersion: number;
  readonly confidenceVersion: number;
  readonly wordCount: number;
  readonly removedWords: number;
  readonly createdAt: string;
}

/** A job as the worker routes check it: whose lease, of what kind, for which item. */
export interface JobLease {
  readonly mediaId: string;
  readonly kind: MediaJobKind;
}

/**
 * Transcripts, their derived segments and words, and the term list (ADR 0023), in the
 * media database. Completing a transcribe job and storing its transcript is one transaction.
 */
export interface TranscriptStorePort {
  /** The newest term list. */
  currentTerms(): TranscriptionTerms;
  /** The list as a version had it; null when there is no such version. */
  termsAt(version: number): TranscriptionTerms | null;
  /** Every version of the list, newest first (KBC-040 BR-1). */
  termVersions(): TermVersion[];
  /** One version of the list, null when unknown. */
  termVersion(version: number): TermVersion | null;
  /**
   * Stores the list as the next version; false when `baseVersion` is no longer the newest.
   * Queues nothing: only a person asks for a transcription again.
   */
  saveTerms(input: {
    readonly baseVersion: number;
    readonly terms: readonly string[];
    readonly author: {
      readonly principal: string;
      readonly name: string | null;
    };
    readonly now: Date;
  }): boolean;
  /** The job when `owner` holds its lease now; null otherwise. */
  heldJob(owner: LeaseOwner): JobLease | null;
  /**
   * Closes the lease and stores the transcript as the item's newest version (BR-3); false
   * when the lease is no longer the owner's.
   */
  completeTranscribe(input: {
    readonly owner: LeaseOwner;
    readonly transcript: NewTranscript;
    readonly now: Date;
    /** Runs in the same transaction, once stored (KBC-068 BR-4: the tracks follow). */
    readonly alongside?: () => void;
  }): boolean;
  /** Stores a track's transcript, replacing the one it had, in the search index too. */
  replaceDerived(transcript: NewTranscript, now: Date): void;
  /** Queues a new transcription of an item; false when one is already queued or running. */
  requestTranscription(input: {
    readonly mediaId: string;
    readonly jobId: string;
    readonly now: Date;
  }): boolean;
  /** Every version of an item's transcript, newest first. */
  transcripts(mediaId: string): TranscriptSummary[];
  segments(transcriptId: string): DerivedSegment[];
  words(transcriptId: string): DerivedWord[];
}
