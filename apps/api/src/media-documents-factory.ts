import type { FastifyInstance } from 'fastify';
import type { MediaDeps } from './media-factory.js';
import { createSubjectDirectory } from './track-subjects-factory.js';
import type { AuthorsService } from './modules/authors/index.js';
import type { CatalogRegistry } from './modules/catalog/index.js';
import {
  ExistingTracks,
  KbPublishService,
  MediaDocumentReconciler,
  TrackDocumentSource,
} from './modules/media-documents/index.js';
import { JOB_LEASE_MS, MAX_JOB_ATTEMPTS } from './modules/media/index.js';

/** The backstop of the reconciliation (ADR 0035 §4). */
export const RECONCILE_INTERVAL_MS = 10 * 60 * 1000;

export interface MediaDocuments {
  readonly reconciler: MediaDocumentReconciler;
  readonly kb: KbPublishService;
  readonly existing: ExistingTracks;
}

/** Track documents (KBC-099, ADR 0035): rendered from media.db, published through the Mac. */
interface DocumentsWiring {
  readonly media: MediaDeps;
  readonly catalog: CatalogRegistry;
  readonly authors: AuthorsService;
  /** Where a track that could not be rendered is told (the app's log). */
  readonly onRenderError?: (mediaId: string, err: unknown) => void;
}

/** What a track's document is read from: media.db, the authors and the subjects. */
function documentSource(wiring: DocumentsWiring): TrackDocumentSource {
  const { media, authors } = wiring;
  const subjects = createSubjectDirectory(wiring);
  return new TrackDocumentSource({
    store: media.store,
    items: media.trackItems,
    transcripts: media.transcripts,
    mainOf: (topic) => authors.mainOf(topic)?.slug ?? null,
    authorOf: (topic, slug) => authors.authorOf(topic, slug),
    domainOf: (topic) => wiring.catalog.get(topic)?.topic.domain ?? null,
    subjectsOf: (track) =>
      (subjects.shownOn([track]).get(track.mediaId) ?? []).map(
        (subject) => subject.name,
      ),
  });
}

export function createMediaDocuments(wiring: DocumentsWiring): MediaDocuments {
  const { media } = wiring;
  const reconciler = new MediaDocumentReconciler({
    source: documentSource(wiring),
    documents: media.documents,
    liveTracks: () => media.documents.liveTracks(),
    ...(wiring.onRenderError && { onError: wiring.onRenderError }),
  });
  const kb = new KbPublishService({
    documents: media.documents,
    reconciler,
    spend: media.spend,
    monthlyCapUsd: media.ai.monthlyCapUsd,
    leaseMs: JOB_LEASE_MS,
    maxAttempts: MAX_JOB_ATTEMPTS,
  });
  const existing = new ExistingTracks({
    documents: media.documents,
    reconciler,
    budget: kb,
    titleOf: (topic) => wiring.catalog.get(topic)?.topic.title ?? null,
  });
  return { reconciler, kb, existing };
}

/** Every 10 minutes, whatever a missed callback left behind is published (ADR 0035 §4). */
export function startDocumentBackstop(
  app: FastifyInstance,
  reconciler: MediaDocumentReconciler,
): void {
  const timer = setInterval(() => {
    try {
      reconciler.reconcileAll();
    } catch (err) {
      app.log.error({ err }, 'track documents: the backstop failed');
    }
  }, RECONCILE_INTERVAL_MS);
  timer.unref();
  app.addHook('onClose', async () => clearInterval(timer));
}
