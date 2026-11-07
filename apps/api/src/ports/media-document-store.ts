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

/** What a lease delivered: a document written with its fingerprint, or one removed. */
export type DeliveredDocument =
  | {
      readonly op: 'write';
      readonly mediaId: string;
      readonly path: string;
      readonly fingerprint: string;
    }
  | {
      readonly op: 'remove';
      readonly mediaId: string;
      readonly path: string;
    };

/** Where a document stands, from its row (KBC-100 BR-4). */
export interface DocumentStatus {
  readonly topic: string;
  readonly desiredFingerprint: string;
  /** What production's catalog last saw of it; null before it saw any. */
  readonly liveFingerprint: string | null;
  readonly liveAt: string | null;
  readonly attempts: number;
  readonly lastError: string | null;
  readonly updatedAt: string;
}

/** A document kb or the Mac gave up on (the attempts are spent). */
export interface FailedDocumentRow {
  readonly mediaId: string;
  readonly topic: string;
  readonly title: string;
  readonly error: string;
  readonly since: string;
}

/** The queue as masters see it: what still waits, the last publication, what failed. */
export interface QueueSummary {
  readonly waiting: number;
  readonly lastPublishedAt: string | null;
  readonly failed: readonly FailedDocumentRow[];
}

/** One automatic sync of the vault with production, as the Mac reported it (FR-4). */
export interface VaultSyncRecord {
  readonly id: string;
  readonly worker: string;
  readonly ok: boolean;
  readonly detail: string;
  readonly startedAt: string;
  readonly finishedAt: string;
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
  /**
   * Records what the app wants; true when it differs from what was last wanted. A document
   * that moved (another collection or path) leaves a removal at its old place; one wanted
   * again at a place waiting to be emptied keeps its file (the removal is dropped).
   */
  desire(document: DesiredDocument): boolean;
  /**
   * The media stopped having a document (archived, deleted, moved out, its recording got
   * tracks): its file is to be removed. The collection it leaves; null when it had none.
   */
  retire(mediaId: string, now: Date): string | null;
  /** The documents of a collection still to publish, oldest change first. */
  pendingOf(topic: string, limit: number): readonly PendingDocument[];
  /** The documents of a collection still to remove from the vault, oldest first. */
  removalsOf(topic: string, limit: number): readonly PendingDocument[];
  /** Whether a collection has anything for the Mac (to write or to remove). */
  hasPending(topic: string): boolean;
  /**
   * Every media with a document row (the backstop sweep). Tracks published before KBC-099
   * get theirs by the master's action (KBC-099 AC-16), by the owner's choice of when kb spends.
   */
  documented(): readonly string[];
  /** The media with a document under a recording's folder (itself and its tracks). */
  documentedUnder(recordingId: string): readonly string[];
  /**
   * Transcribed recordings with no track at all and no document yet, at most `perTopic` of
   * each collection: the backfill (KBC-100 FR-7), a batch per sweep.
   */
  undocumentedRecordings(perTopic: number): readonly string[];
  /** Whether a recording has, or ever had, a track (live, archived or being cut). */
  hasTracks(recordingId: string): boolean;
  /** A document's row; null without one. */
  statusOf(mediaId: string): DocumentStatus | null;
  /** **Tentar de novo**: the attempts start over. False without a row. */
  retry(mediaId: string, now: Date): boolean;
  /**
   * What production's catalog sees (FR-6): a document whose desired fingerprint is the one
   * seen becomes live. How many changed.
   */
  markLive(
    seen: readonly { readonly mediaId: string; readonly fingerprint: string }[],
    now: Date,
  ): number;
  queueSummary(): QueueSummary;
  recordSync(sync: VaultSyncRecord): void;
  lastSync(): VaultSyncRecord | null;
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
