import type { KbFacets } from '@kb-chat/contracts';
import type { LeaseOwner } from './media-store.js';

/** A track's document as the app wants it now (ADR 0035 §4). */
export interface DesiredDocument {
  readonly mediaId: string;
  /** The collection whose vault folder holds it. */
  readonly topic: string;
  /** Relative to that folder. */
  readonly path: string;
  readonly fingerprint: string;
  readonly now: Date;
}

/** A document still to reach the vault: never published, or published with another text. */
export interface PendingDocument {
  readonly mediaId: string;
  readonly path: string;
}

/** What a lease delivered: the documents and the fingerprint each was rendered with. */
export interface DeliveredDocument {
  readonly mediaId: string;
  readonly path: string;
  readonly fingerprint: string;
}

/** A live track and the collection it is in. */
export interface PublishableTrack {
  readonly mediaId: string;
  readonly topic: string;
}

/** Live tracks with no document yet; documents waiting for the Mac, published, failed. */
export interface DocumentCounts {
  readonly undocumented: number;
  readonly queued: number;
  readonly published: number;
  readonly failed: number;
}

/** A leased kb-publish job, before its documents are rendered. */
export interface LeasedKbJob {
  readonly id: string;
  readonly leaseId: string;
  readonly topic: string;
  readonly attempt: number;
}

/** What kb did to one written document, as the Mac reports it. */
export interface DocumentOutcome {
  readonly path: string;
  readonly ok: boolean;
  readonly error?: string;
  readonly facets?: KbFacets;
  readonly spendUsd: number;
}

/** The track documents and their kb-publish queue, in the media database (ADR 0035 §3-4). */
export interface MediaDocumentStorePort {
  /** Records what the app wants; true when it differs from what was last wanted. */
  desire(document: DesiredDocument): boolean;
  /** The documents of a collection still to publish, oldest change first. */
  pendingOf(topic: string, limit: number): readonly PendingDocument[];
  /**
   * The live tracks that already have a document (the backstop sweep). Tracks published
   * before KBC-099 get theirs in KBC-100, by the owner's choice of when kb spends on them.
   */
  liveTracks(): readonly string[];
  /**
   * Every published, ready, non-archived track with a transcript, in the library (or one
   * collection), with a document or not: what "Publicar no acervo as faixas que já existem"
   * goes over.
   */
  publishableTracks(topic?: string): readonly PublishableTrack[];
  /** A collection's live tracks, by the state of their document (none yet included). */
  countsOf(topic: string): DocumentCounts;
  /** The fingerprint the app last wanted for a track; null without a document. */
  desiredFingerprint(mediaId: string): string | null;
  /** What the Mac last published of a track; null before the first publication. */
  publishedFingerprint(mediaId: string): string | null;
  /** One queued job per collection: a second call while one waits does nothing. */
  enqueue(input: {
    readonly topic: string;
    readonly id: string;
    readonly now: Date;
  }): void;
  /** The oldest waiting job (queued, or leased and expired) for this worker. */
  lease(input: {
    readonly worker: string;
    readonly leaseId: string;
    readonly now: Date;
    readonly leaseMs: number;
    readonly maxAttempts: number;
    /** Only this collection's job (the E2E's fake Mac); any by default. */
    readonly topic?: string;
  }): LeasedKbJob | null;
  /** Whether this worker holds a kb-publish lease now. */
  holds(worker: string): boolean;
  /** Keeps what a lease delivered, for its result. */
  deliver(
    owner: LeaseOwner,
    input: {
      readonly items: readonly DeliveredDocument[];
      readonly budgetUsd: number;
    },
  ): boolean;
  /** Ends a lease with nothing to deliver (everything already published). */
  finishEmpty(owner: LeaseOwner, now: Date): void;
  isJob(jobId: string): boolean;
  heartbeat(
    owner: LeaseOwner,
    input: { readonly now: Date; readonly leaseMs: number },
  ): boolean;
  /**
   * Back to the queue, or `dead` past the attempts. What the lease delivered (to book what
   * kb spent before failing); null when the lease is not held.
   */
  fail(
    owner: LeaseOwner,
    input: {
      readonly error: string;
      readonly now: Date;
      readonly maxAttempts: number;
    },
  ): readonly DeliveredDocument[] | null;
  /**
   * The result of a lease: each delivered document it names is published (or failed) with
   * the fingerprint it was rendered with. Null when the lease is not held any more.
   */
  complete(
    owner: LeaseOwner,
    input: {
      readonly outcomes: readonly DocumentOutcome[];
      readonly now: Date;
    },
  ): {
    readonly topic: string;
    readonly delivered: readonly DeliveredDocument[];
  } | null;
}
