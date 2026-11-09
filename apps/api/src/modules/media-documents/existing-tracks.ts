import {
  KB_PUBLISH_USD_PER_TRACK,
  type PublicationQueue,
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
    'publishableTracks' | 'countsOf' | 'desiredFingerprint'
  >;
  readonly reconciler: Pick<
    MediaDocumentReconciler,
    'render' | 'enqueueIfPending'
  >;
  /** The media monthly ceiling (ADR 0035 §11). */
  readonly budget: { remainingUsd(): number; budgetUsd(): number };
  /** A collection's title; null for one the app does not know (KBC-114: with a vault folder or not). */
  readonly titleOf: (topic: string) => string | null;
  /** The publishing queue as masters see it (KBC-100 FR-3). */
  readonly queue?: () => PublicationQueue;
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

  /**
   * Read from the documents' rows, never by rendering (review round 2: the screen asks
   * every 20 s): "to publish" is a live track with no document yet; one already queued is
   * counted as queued only.
   */
  overview(): TrackDocumentsOverview {
    const topics = new Map<string, number>();
    for (const { topic } of this.deps.documents.publishableTracks())
      topics.set(topic, (topics.get(topic) ?? 0) + 1);
    const collections: TrackDocumentsCollection[] = [];
    for (const [topic, tracks] of topics) {
      const title = this.deps.titleOf(topic);
      if (title === null) continue;
      const { undocumented, ...counts } = this.deps.documents.countsOf(topic);
      collections.push({
        topic,
        title,
        tracks,
        toPublish: undocumented,
        ...counts,
      });
    }
    return {
      usdPerTrack: KB_PUBLISH_USD_PER_TRACK,
      remainingUsd: this.deps.budget.remainingUsd(),
      collections,
      ...(this.deps.queue && { queue: this.deps.queue() }),
    };
  }

  /** Every chosen collection is checked before anything is queued. */
  publish(topics: readonly string[]): PublishExistingTracksResult {
    for (const topic of topics)
      if (this.deps.titleOf(topic) === null)
        throw new AppError('TOPIC_NOT_FOUND', `Unknown topic ${topic}`);
    if (this.deps.budget.budgetUsd() <= 0) throw capReached();
    const total = { queued: 0, skipped: 0 };
    for (const topic of new Set(topics)) {
      const one = this.publishTopic(topic);
      total.queued += one.queued;
      total.skipped += one.skipped;
    }
    return total;
  }

  private publishTopic(topic: string): PublishExistingTracksResult {
    const result = { queued: 0, skipped: 0 };
    for (const { mediaId } of this.deps.documents.publishableTracks(topic)) {
      // Already wanted as it renders now (published or in the queue): nothing new.
      const wanted = this.deps.documents.desiredFingerprint(mediaId);
      const rendered = this.deps.reconciler.render(mediaId);
      if (!rendered) continue;
      if (wanted === rendered.fingerprint) result.skipped += 1;
      else result.queued += 1;
    }
    this.deps.reconciler.enqueueIfPending(topic);
    return result;
  }
}
