import { randomUUID } from 'node:crypto';
import type {
  PublicationQueue,
  TrackPublication,
  VaultSyncReport,
} from '@kb-chat/contracts';
import type { MediaDocumentStorePort } from '../../ports/media-document-store.js';
import type { MediaRecord, MediaStorePort } from '../../ports/media-store.js';
import type { MediaDocumentReconciler } from './reconciler.js';

/** kb's or the Mac's failure, said in one line under the title (T22). */
const REASON_CHARS = 200;

/** A document is given up on after this many failed runs (BR-5). */
export const PUBLICATION_ATTEMPTS = 4;

/** Whether a Mac that publishes is seen now, or since when it is not (ADR 0035 §10). */
export interface PublisherPresence {
  readonly transcriber: 'on' | 'off' | 'none';
  readonly offSince: string | null;
}

/** A document the catalog of production holds, with the fingerprint written in it. */
export interface SeenDocument {
  readonly mediaId: string;
  readonly fingerprint: string;
}

export interface PublicationStatusDeps {
  readonly documents: Pick<
    MediaDocumentStorePort,
    'statusOf' | 'retry' | 'queueSummary' | 'markLive' | 'recordSync' | 'lastSync'
  >;
  readonly reconciler: Pick<
    MediaDocumentReconciler,
    'reconcileTracks' | 'enqueueIfPending'
  >;
  readonly store: Pick<MediaStorePort, 'getMedia'>;
  /** Whether a media may have a document now (a published track, an untracked recording). */
  readonly isDocumentable: (media: MediaRecord | null) => boolean;
  readonly hasFolder: (topic: string) => boolean;
  /** What kb may still spend this month; zero is the media ceiling reached (BR-6). */
  readonly budgetUsd: () => number;
  readonly presence: () => PublisherPresence;
  readonly now?: () => Date;
}

const reasonOf = (error: string | null): string => {
  const line =
    (error ?? '')
      .split('\n')
      .map((one) => one.trim())
      .find(Boolean) ?? 'o kb falhou';
  return line.length > REASON_CHARS
    ? `${line.slice(0, REASON_CHARS - 1)}…`
    : line;
};

/**
 * Where each document stands in the AI research (KBC-100 BR-4, FR-3, FR-6): **Na pesquisa**
 * only when production's catalog sees the fingerprint the app wants now; otherwise why not.
 */
export class PublicationStatus {
  private readonly now: () => Date;

  constructor(private readonly deps: PublicationStatusDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  /** Null for a media that has no document (it is not, and is not meant to be, searched). */
  of(mediaId: string): TrackPublication | null {
    const media = this.deps.store.getMedia(mediaId);
    if (!media || !this.deps.isDocumentable(media)) return null;
    if (!this.deps.hasFolder(media.topic))
      return { state: 'out', reason: 'no-folder' };
    const row = this.deps.documents.statusOf(mediaId);
    const capped = this.deps.budgetUsd() <= 0;
    if (!row) return { state: 'out', reason: capped ? 'cap' : 'not-published' };
    if (row.liveFingerprint === row.desiredFingerprint)
      return { state: 'live', since: row.liveAt ?? row.updatedAt };
    if (row.attempts >= PUBLICATION_ATTEMPTS)
      return {
        state: 'failed',
        since: row.updatedAt,
        reason: reasonOf(row.lastError),
      };
    if (capped) return { state: 'out', reason: 'cap' };
    const presence = this.deps.presence();
    if (presence.transcriber !== 'on')
      return { state: 'waiting-mac', offSince: presence.offSince };
    return { state: 'updating', since: row.updatedAt };
  }

  /** **Tentar de novo** (AC-10): the attempts start over and the collection's job waits. */
  retry(mediaId: string): TrackPublication | null {
    const status = this.deps.documents.statusOf(mediaId);
    if (status && this.deps.documents.retry(mediaId, this.now()))
      this.deps.reconciler.enqueueIfPending(status.topic);
    else this.deps.reconciler.reconcileTracks([mediaId]);
    return this.of(mediaId);
  }

  /** The queue for masters in Transcritores (T22). */
  queue(): PublicationQueue {
    const summary = this.deps.documents.queueSummary();
    const sync = this.deps.documents.lastSync();
    return {
      waiting: summary.waiting,
      lastPublishedAt: summary.lastPublishedAt,
      lastSync: sync
        ? {
            ok: sync.ok,
            detail: sync.detail,
            startedAt: sync.startedAt,
            finishedAt: sync.finishedAt,
          }
        : null,
      failed: summary.failed.map((one) => ({
        ...one,
        error: reasonOf(one.error),
      })),
    };
  }

  /** What the Mac reported of a sync with production (FR-4). */
  recordSync(worker: string, report: VaultSyncReport): void {
    this.deps.documents.recordSync({ id: randomUUID(), worker, ...report });
  }

  /** The catalog was (re)loaded: what it sees is what production searches (FR-6). */
  observe(seen: readonly SeenDocument[]): number {
    return this.deps.documents.markLive(seen, this.now());
  }
}
