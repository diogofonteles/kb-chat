import type { TranscriptionHold } from '@kb-chat/contracts';
import type { LeaseOwner } from './media-store.js';

/** A transcription waiting in the queue, with what Groq needs to price it. */
export interface WaitingTranscription {
  readonly jobId: string;
  readonly mediaId: string;
  /** Its audio's length; null for an item converted before durations were kept. */
  readonly durationMs: number | null;
  readonly route: 'transcriber' | 'groq';
  readonly createdAt: string;
}

/**
 * The queue as the Groq fallback sees it (KBC-037, ADR 0023 §7): which transcriptions wait
 * for the Mac, routing one to Groq or holding it for the cap, and giving a Groq job back.
 */
export interface GroqQueuePort {
  /** Transcriptions queued for a paired transcriber since before `queuedBefore`, oldest first. */
  waitingSince(queuedBefore: Date): WaitingTranscription[];
  /** The item's queued transcription, if any. */
  waitingOf(mediaId: string): WaitingTranscription | null;
  /** Sends a queued job to Groq; false when it is no longer queued for the transcriber. */
  routeToGroq(input: { readonly jobId: string; readonly now: Date }): boolean;
  /** Marks why Groq left a queued job to the transcriber (FR-4). */
  hold(input: {
    readonly jobId: string;
    readonly hold: TranscriptionHold;
    readonly now: Date;
  }): void;
  /** The item and length of a Groq job this lease holds; null otherwise. */
  heldGroqJob(
    owner: LeaseOwner,
  ): { readonly mediaId: string; readonly durationMs: number | null } | null;
  /**
   * The Groq job goes back to the queue, for the transcriber, with `hold` saying why (FR-4);
   * false when the lease is no longer the owner's.
   */
  backToTranscriber(input: {
    readonly owner: LeaseOwner;
    readonly hold: TranscriptionHold | null;
    readonly now: Date;
  }): boolean;
}
