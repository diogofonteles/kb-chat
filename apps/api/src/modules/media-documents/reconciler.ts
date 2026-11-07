import { randomUUID } from 'node:crypto';
import type { MediaDocumentStorePort } from '../../ports/media-document-store.js';
import type { TrackDocumentSource } from './document-source.js';
import {
  renderTrackDocument,
  type RenderedDocument,
} from './track-document.js';

export interface ReconcilerDeps {
  readonly source: Pick<TrackDocumentSource, 'inputOf' | 'tracksOf'>;
  readonly documents: Pick<
    MediaDocumentStorePort,
    'desire' | 'pendingOf' | 'enqueue'
  >;
  /** Every live track of the media library, for the backstop sweep. */
  readonly liveTracks: () => readonly string[];
  /** A track whose document could not be rendered (logged; the sweep tries it again). */
  readonly onError?: (mediaId: string, err: unknown) => void;
  readonly now?: () => Date;
  readonly newId?: () => string;
}

/** A rendered document with the track and collection it belongs to. */
export interface TrackRender extends RenderedDocument {
  readonly mediaId: string;
  readonly topic: string;
}

/**
 * Keeps the vault's track documents fresh by reconciliation, not by callbacks (ADR 0035 §4):
 * each publishable track is rendered (cheap: text from media.db), its fingerprint recorded as
 * the wanted one, and a collection with anything to publish gets one queued kb-publish job.
 * Removing documents and the other change callbacks are KBC-100.
 */
export class MediaDocumentReconciler {
  private readonly now: () => Date;
  private readonly newId: () => string;
  /**
   * Tracks whose render threw: the sweep renders them again, since a first render that
   * failed left no `media_documents` row for `liveTracks` to find. Kept in memory: after a
   * restart such a track gets its document at its next change (or KBC-100's catch-up).
   */
  private readonly unrendered = new Set<string>();

  constructor(private readonly deps: ReconcilerDeps) {
    this.now = deps.now ?? (() => new Date());
    this.newId = deps.newId ?? randomUUID;
  }

  /** The document of a track as it is now, without recording anything; null if none. */
  preview(mediaId: string): TrackRender | null {
    const input = this.deps.source.inputOf(mediaId);
    if (!input) return null;
    return { ...renderTrackDocument(input), mediaId, topic: input.topic };
  }

  /** The document of a track as it is now, recorded as the one to publish; null if none. */
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

  /** A recording's tracks were published (KBC-068): their documents follow (FR-1). */
  reconcileRecording(parentId: string): void {
    this.reconcile(this.deps.source.tracksOf(parentId));
  }

  /** The backstop, every 10 minutes: whatever a missed callback left behind. */
  reconcileAll(): void {
    this.reconcile([
      ...new Set([...this.deps.liveTracks(), ...this.unrendered]),
    ]);
  }

  /**
   * Runs inside the publication's transaction (KBC-068): a track that cannot be rendered is
   * logged and left for the sweep, never thrown, so it never undoes the publication.
   */
  private reconcile(mediaIds: readonly string[]): void {
    const topics = new Set<string>();
    for (const mediaId of mediaIds) {
      const rendered = this.tryRender(mediaId);
      if (rendered) topics.add(rendered.topic);
    }
    for (const topic of topics) this.enqueueIfPending(topic);
  }

  private tryRender(mediaId: string): TrackRender | null {
    try {
      const rendered = this.render(mediaId);
      this.unrendered.delete(mediaId);
      return rendered;
    } catch (err) {
      this.unrendered.add(mediaId);
      this.deps.onError?.(mediaId, err);
      return null;
    }
  }

  /** One queued job per collection, only when something waits to be published. */
  enqueueIfPending(topic: string): void {
    if (this.deps.documents.pendingOf(topic, 1).length === 0) return;
    this.deps.documents.enqueue({ topic, id: this.newId(), now: this.now() });
  }
}
