import type { FastifyInstance } from 'fastify';
import type { MediaDeps } from './media-factory.js';
import { createSubjectDirectory } from './track-subjects-factory.js';
import type { AuthorsService } from './modules/authors/index.js';
import type { CatalogRegistry } from './modules/catalog/index.js';
import {
  ExistingTracks,
  KbPublishService,
  MediaDocumentReconciler,
  PublicationStatus,
  TrackDocumentSource,
  type PublisherPresence,
  type SeenDocument,
} from './modules/media-documents/index.js';
import { JOB_LEASE_MS, MAX_JOB_ATTEMPTS } from './modules/media/index.js';

export interface MediaDocuments {
  readonly reconciler: MediaDocumentReconciler;
  readonly kb: KbPublishService;
  readonly existing: ExistingTracks;
  readonly status: PublicationStatus;
}

/** Track documents (KBC-099, ADR 0035): rendered from media.db, published through the Mac. */
interface DocumentsWiring {
  readonly media: MediaDeps;
  readonly catalog: CatalogRegistry;
  readonly authors: AuthorsService;
  /** Where a track that could not be rendered is told (the app's log). */
  readonly onRenderError?: (mediaId: string, err: unknown) => void;
  /** Who speaks in each segment, by the names listeners see (KBC-065). */
  readonly speakersOf?: (mediaId: string) => readonly (string | null)[];
  /** Whether a Mac marked "Publica no acervo" is seen (ADR 0035 §10). */
  readonly presence?: () => PublisherPresence;
}

/** No Mac known: the queue waits (a test world without transcribers). */
const NO_PUBLISHER: PublisherPresence = { transcriber: 'none', offSince: null };

/** Every track document the catalog holds now, with the fingerprint written in it. */
export const seenIn = (catalog: CatalogRegistry): SeenDocument[] =>
  catalog.topics().flatMap((one) =>
    [...one.entries.values()].flatMap((entry) =>
      entry.media
        ? [
            {
              mediaId: entry.media.mediaId,
              fingerprint: entry.media.fingerprint,
            },
          ]
        : [],
    ),
  );

/** A collection with a folder in the kb vault: one created on the screen may have none. */
export const hasVaultFolder =
  (catalog: CatalogRegistry) =>
  (topic: string): boolean => {
    const found = catalog.get(topic);
    return found !== undefined && found.topic.screenOnly !== true;
  };

/** What a track's document is read from: media.db, the authors and the subjects. */
export function documentSource(wiring: DocumentsWiring): TrackDocumentSource {
  const { media, authors } = wiring;
  const subjects = createSubjectDirectory(wiring);
  return new TrackDocumentSource({
    store: media.store,
    items: media.trackItems,
    transcripts: media.transcripts,
    hasTracks: (recordingId) => media.documents.hasTracks(recordingId),
    ...(wiring.speakersOf && { speakersOf: wiring.speakersOf }),
    mainOf: (topic) => authors.mainOf(topic)?.slug ?? null,
    authorOf: (topic, slug) => authors.authorOf(topic, slug),
    domainOf: (topic) => wiring.catalog.get(topic)?.topic.domain ?? null,
    subjectsOf: (track) =>
      (subjects.shownOn([track]).get(track.mediaId) ?? []).map(
        (subject) => subject.name,
      ),
  });
}

/** The reconciler over media.db and the vault's folders. */
function reconcilerOf(
  wiring: DocumentsWiring,
  source: TrackDocumentSource,
): MediaDocumentReconciler {
  const { media } = wiring;
  return new MediaDocumentReconciler({
    source,
    documents: media.documents,
    hasFolder: hasVaultFolder(wiring.catalog),
    // A sub-collection uses its parent's authors and speakers (ADR 0028).
    mediaOf: (topic) =>
      wiring.catalog
        .scope(topic)
        .flatMap((one) => media.store.listMedia(one.topic.slug))
        .map((one) => one.id),
    ...(wiring.onRenderError && { onError: wiring.onRenderError }),
  });
}

export function createMediaDocuments(wiring: DocumentsWiring): MediaDocuments {
  const { media } = wiring;
  const source = documentSource(wiring);
  const reconciler = reconcilerOf(wiring, source);
  const kb = new KbPublishService({
    documents: media.documents,
    reconciler,
    spend: media.spend,
    monthlyCapUsd: media.ai.monthlyCapUsd,
    leaseMs: JOB_LEASE_MS,
    maxAttempts: MAX_JOB_ATTEMPTS,
  });
  const status = publicationStatus(wiring, { source, reconciler, kb });
  const existing = new ExistingTracks({
    documents: media.documents,
    reconciler,
    budget: kb,
    // A collection with no vault folder has nothing to publish yet (KBC-100 AC-12).
    titleOf: (topic) =>
      hasVaultFolder(wiring.catalog)(topic)
        ? (wiring.catalog.get(topic)?.topic.title ?? null)
        : null,
    queue: () => status.queue(),
  });
  return { reconciler, kb, existing, status };
}

/** Where each document stands (KBC-100 BR-4), from the same parts. */
function publicationStatus(
  wiring: DocumentsWiring,
  parts: {
    source: TrackDocumentSource;
    reconciler: MediaDocumentReconciler;
    kb: KbPublishService;
  },
): PublicationStatus {
  const { media } = wiring;
  const { source, reconciler, kb } = parts;
  return new PublicationStatus({
    documents: media.documents,
    reconciler,
    store: media.store,
    isDocumentable: (one) => source.isDocumentable(one),
    hasFolder: hasVaultFolder(wiring.catalog),
    budgetUsd: () => kb.budgetUsd(),
    presence: wiring.presence ?? (() => NO_PUBLISHER),
  });
}

/** Every 10 minutes, whatever a missed callback left behind is published (ADR 0035 §4). */
export function startDocumentBackstop(
  app: FastifyInstance,
  reconciler: MediaDocumentReconciler,
  intervalMs: number,
): void {
  const timer = setInterval(() => {
    try {
      reconciler.reconcileAll();
    } catch (err) {
      app.log.error({ err }, 'track documents: the backstop failed');
    }
  }, intervalMs);
  timer.unref();
  app.addHook('onClose', async () => clearInterval(timer));
}
