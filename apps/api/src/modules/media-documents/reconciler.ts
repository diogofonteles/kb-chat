import { randomUUID } from 'node:crypto';
import type { MediaDocumentStorePort } from '../../ports/media-document-store.js';
import type { TrackDocumentSource } from './document-source.js';
import {
  renderTrackDocument,
  type RenderedDocument,
} from './track-document.js';

/** Recordings without tracks given a document per collection by each sweep (FR-7). */
export const BACKFILL_BATCH = 50;

export interface ReconcilerDeps {
  readonly source: Pick<TrackDocumentSource, 'inputOf' | 'tracksOf'>;
  readonly documents: Pick<
    MediaDocumentStorePort,
    | 'desire'
    | 'retire'
    | 'hasPending'
    | 'enqueue'
    | 'documented'
    | 'documentedUnder'
    | 'undocumentedRecordings'
    | 'statusOf'
  >;
  /**
   * Whether a collection has a folder in the kb vault (one created on the screen may not):
   * without one nothing is published there (KBC-100 AC-12).
   */
  readonly hasFolder: (topic: string) => boolean;
  /** The media of a collection that may have a document (an authorship change, BR-1). */
  readonly mediaOf?: (topic: string) => readonly string[];
  /** A media whose document could not be rendered (logged; the sweep tries it again). */
  readonly onError?: (mediaId: string, err: unknown) => void;
  readonly now?: () => Date;
  readonly newId?: () => string;
}

/** A rendered document with the media and collection it belongs to. */
export interface TrackRender extends RenderedDocument {
  readonly mediaId: string;
  readonly topic: string;
}

/**
 * Keeps the vault's track documents fresh by reconciliation (ADR 0035 §4): whatever changed,
 * the media it touches are rendered again (cheap: text from media.db). A different render
 * is wanted (`write`), a media that stopped having a document leaves a removal at its old
 * place (`remove`), and each collection with anything for the Mac keeps one queued job.
 * Every entry point is synchronous, so a caller runs it inside its own transaction.
 */
export class MediaDocumentReconciler {
  private readonly now: () => Date;
  private readonly newId: () => string;
  /**
   * Media whose render threw: the sweep renders them again, since a first render that
   * failed left no `media_documents` row for it to find. Kept in memory: after a restart
   * such a media gets its document at its next change.
   */
  private readonly unrendered = new Set<string>();

  constructor(private readonly deps: ReconcilerDeps) {
    this.now = deps.now ?? (() => new Date());
    this.newId = deps.newId ?? randomUUID;
  }

  /** The document of a media as it is now, without recording anything; null if none. */
  preview(mediaId: string): TrackRender | null {
    const input = this.deps.source.inputOf(mediaId);
    if (!input || !this.deps.hasFolder(input.topic)) return null;
    return { ...renderTrackDocument(input), mediaId, topic: input.topic };
  }

  /** The document of a media as it is now, recorded as the one to publish; null if none. */
  render(mediaId: string): TrackRender | null {
    const rendered = this.preview(mediaId);
    if (!rendered) return null;
    this.deps.documents.desire({
      mediaId,
      topic: rendered.topic,
      path: rendered.path,
      fingerprint: rendered.fingerprint,
      now: this.now(),
    });
    return rendered;
  }

  /**
   * Something of a recording changed (a transcript, its details, a track's revision, an
   * archive, a restore, a publication, a deletion, subjects or a speaker's name): the
   * recording's own document and every track it has, or had, follow (FR-1).
   */
  reconcileRecording(recordingId: string): void {
    this.reconcile([
      recordingId,
      ...this.deps.source.tracksOf(recordingId),
      ...this.deps.documents.documentedUnder(recordingId),
    ]);
  }

  /**
   * **The text of these media changed** (KBC-093's word correction, ADR 0034 §5 and its
   * amendment 8): only they are rendered again, and one job is queued per collection they
   * are in. Synchronous: call it inside the correction's transaction, after the tracks'
   * slices were replaced. A media whose text did not really change renders the same
   * fingerprint and queues nothing (BR-1).
   */
  reconcileTracks(mediaIds: readonly string[]): void {
    this.reconcile(mediaIds);
  }

  /** Something of a whole collection changed (its main author, an author's name). */
  reconcileTopic(topic: string): void {
    this.reconcile(this.deps.mediaOf?.(topic) ?? []);
  }

  /**
   * The backstop, every 10 minutes: every document the app has (a missed callback, a
   * removal), the renders that failed, and a batch of recordings without tracks (FR-7).
   */
  reconcileAll(): void {
    const { documents } = this.deps;
    this.reconcile([
      ...documents.documented(),
      ...this.unrendered,
      ...documents.undocumentedRecordings(BACKFILL_BATCH),
    ]);
  }

  /**
   * Runs inside the caller's transaction: a media that cannot be rendered is logged and left
   * for the sweep, never thrown, so it never undoes what the person did.
   */
  private reconcile(mediaIds: readonly string[]): void {
    const topics = new Set<string>();
    for (const mediaId of new Set(mediaIds)) {
      for (const topic of this.follow(mediaId)) topics.add(topic);
    }
    for (const topic of topics) this.enqueueIfPending(topic);
  }

  /** The collections a media's document touched: where it is wanted, where it left. */
  private follow(mediaId: string): readonly string[] {
    // Where it was: a move leaves a removal there, whose collection needs its job too.
    const before = this.deps.documents.statusOf(mediaId)?.topic;
    const outcome = this.settle(mediaId);
    if (outcome === 'failed') return [];
    return [outcome.rendered?.topic, outcome.left, before].filter(
      (topic): topic is string => typeof topic === 'string',
    );
  }

  /** Rendered and wanted, or retired; `failed` when the render threw (logged). */
  private settle(
    mediaId: string,
  ): { rendered: TrackRender | null; left: string | null } | 'failed' {
    try {
      const rendered = this.render(mediaId);
      this.unrendered.delete(mediaId);
      const left = rendered
        ? null
        : this.deps.documents.retire(mediaId, this.now());
      return { rendered, left };
    } catch (err) {
      this.unrendered.add(mediaId);
      this.deps.onError?.(mediaId, err);
      return 'failed';
    }
  }

  /** A queued job's media, rendered again at lease: its current text, or its removal. */
  refresh(mediaId: string): TrackRender | null {
    const outcome = this.settle(mediaId);
    return outcome === 'failed' ? null : outcome.rendered;
  }

  /** One queued job per collection, only when something waits for the Mac. */
  enqueueIfPending(topic: string): void {
    if (!this.deps.documents.hasPending(topic)) return;
    this.deps.documents.enqueue({ topic, id: this.newId(), now: this.now() });
  }
}
