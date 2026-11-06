import {
  KB_PUBLISH_USD_PER_TRACK,
  type PublishExistingTracksResult,
  type TrackDocumentsCollection,
  type TrackDocumentsOverview,
} from '@kb-chat/contracts';
import { AppError } from '../../app-error.js';
import type { MediaDocumentStorePort } from '../../ports/media-document-store.js';
import type { MediaDocumentReconciler } from './reconciler.js';

export interface ExistingTracksDeps {
  readonly documents: Pick<
    MediaDocumentStorePort,
    'publishableTracks' | 'countsOf' | 'publishedFingerprint'
  >;
  readonly reconciler: Pick<
    MediaDocumentReconciler,
    'preview' | 'render' | 'enqueueIfPending'
  >;
  /** The media monthly ceiling (ADR 0035 §11). */
  readonly budget: { remainingUsd(): number; budgetUsd(): number };
  /** A collection's title in the vault; null when it has no folder there. */
  readonly titleOf: (topic: string) => string | null;
}

const capReached = () =>
  new AppError(
    'MEDIA_SPEND_CAP',
    'The media monthly ceiling is spent: nothing more is published this month',
  );

/**
 * "Publicar no acervo as faixas que já existem" (KBC-099, the owner's scope of 2026-11-06):
 * a master sees, per collection, the published tracks whose document is not in the vault as
 * they are now, with kb's estimated cost, and queues them for the Mac. Rendering is cheap
 * (text from media.db); kb runs only on the Mac, under the media ceiling. Tracks already
 * published with the same fingerprint are skipped, so asking twice queues nothing new.
 */
export class ExistingTracks {
  constructor(private readonly deps: ExistingTracksDeps) {}

  overview(): TrackDocumentsOverview {
    const byTopic = new Map<string, string[]>();
    for (const { mediaId, topic } of this.deps.documents.publishableTracks())
      byTopic.set(topic, [...(byTopic.get(topic) ?? []), mediaId]);
    const collections: TrackDocumentsCollection[] = [];
    for (const [topic, mediaIds] of byTopic) {
      const title = this.deps.titleOf(topic);
      if (title !== null)
        collections.push(this.collectionOf({ topic, title, mediaIds }));
    }
    return {
      usdPerTrack: KB_PUBLISH_USD_PER_TRACK,
      remainingUsd: this.deps.budget.remainingUsd(),
      collections,
    };
  }

  private collectionOf(input: {
    topic: string;
    title: string;
    mediaIds: readonly string[];
  }): TrackDocumentsCollection {
    const renders = input.mediaIds
      .map((mediaId) => this.deps.reconciler.preview(mediaId))
      .filter((one) => one !== null);
    const toPublish = renders.filter(
      (one) =>
        this.deps.documents.publishedFingerprint(one.mediaId) !==
        one.fingerprint,
    ).length;
    return {
      topic: input.topic,
      title: input.title,
      tracks: renders.length,
      toPublish,
      ...this.deps.documents.countsOf(input.topic),
    };
  }

  /** Every chosen collection is checked before anything is queued. */
  publish(topics: readonly string[]): PublishExistingTracksResult {
    for (const topic of topics)
      if (this.deps.titleOf(topic) === null)
        throw new AppError('TOPIC_NOT_FOUND', `Unknown topic ${topic}`);
    if (this.deps.budget.budgetUsd() <= 0) throw capReached();
    let queued = 0;
    let skipped = 0;
    for (const topic of new Set(topics)) {
      for (const { mediaId } of this.deps.documents.publishableTracks(topic)) {
        const rendered = this.deps.reconciler.render(mediaId);
        if (!rendered) continue;
        const published = this.deps.documents.publishedFingerprint(mediaId);
        if (published === rendered.fingerprint) skipped += 1;
        else queued += 1;
      }
      this.deps.reconciler.enqueueIfPending(topic);
    }
    return { queued, skipped };
  }
}
