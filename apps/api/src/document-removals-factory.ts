import type { FastifyInstance, FastifyRequest } from 'fastify';
import type {
  DocumentLevelsService,
  LevelDirectory,
} from './modules/access-levels/index.js';
import { canSeeTopic, NO_PARENT, viewerOf } from './modules/auth/index.js';
import type { CatalogRegistry } from './modules/catalog/index.js';
import {
  RemovalQueue,
  RemovalService,
  VaultJobs,
  documentRemovalRoutes,
  type RemovalActor,
  type RemovalRecords,
} from './modules/document-removals/index.js';
import type {
  DocIngestWork,
  DocumentUploadService,
} from './modules/document-uploads/index.js';
import { uploadActorOf } from './document-uploads-factory.js';
import { refreshSoon } from './refresh-soon.js';

/** What taking a document out of its collection is built from (KBC-187). */
export interface DocumentRemovalsWiring {
  readonly records: RemovalRecords;
  readonly catalog: CatalogRegistry;
  readonly levels: {
    readonly directory: LevelDirectory;
    readonly documents: DocumentLevelsService;
  };
  readonly uploads: DocumentUploadService;
  readonly docs: DocIngestWork;
  /** The E2E server's fake Mac (KBC-149); nothing in production. */
  readonly onDocIngest?: (queue: DocIngestWork) => void;
}

/** The masters' routes, and one queue for all the Mac does in a collection. */
export async function registerDocumentRemovals(
  app: FastifyInstance,
  wiring: DocumentRemovalsWiring,
): Promise<DocIngestWork> {
  const { records, catalog, uploads } = wiring;
  const service = new RemovalService({
    records,
    catalog,
    levelOf: (topic, id) =>
      wiring.levels.directory.placementsOf(topic)[id]?.level ?? null,
    left: (topic, id) => uploads.documentLeft(topic, id),
  });
  await app.register(
    documentRemovalRoutes({
      service,
      actorOf: (request) => actorOf(app, request, catalog),
    }),
  );
  const jobs = new VaultJobs({
    docs: wiring.docs,
    removals: removalQueue(app, wiring),
    entered: async (jobId, documentId) => {
      const topic = uploads.topicOf(jobId);
      const removed = topic && records.of(topic, documentId);
      if (removed) await records.remove(removed.id);
    },
  });
  wiring.onDocIngest?.(jobs);
  return jobs;
}

/** A master: what they see is theirs to take out. */
function actorOf(
  app: FastifyInstance,
  request: FastifyRequest,
  catalog: CatalogRegistry,
): RemovalActor {
  const { person } = viewerOf(request);
  const parentOf = app.topicParentOf ?? NO_PARENT;
  return {
    email: person.email,
    name: person.name ?? '',
    canSee: (topic) => canSeeTopic(person, topic, parentOf),
    seesDocument: uploadActorOf(request, catalog).seesDocument,
  };
}

const removalQueue = (
  app: FastifyInstance,
  { records, catalog, levels }: DocumentRemovalsWiring,
): RemovalQueue =>
  new RemovalQueue({
    records,
    moved: refreshSoon((topic) => catalog.refresh(topic), {
      onError: (err) =>
        app.log.warn({ err }, 'document removals: a collection was not read'),
    }),
    placeLevel: async ({ topic, document, level, by }) => {
      if (level === null) return;
      await levels.documents.placeArriving(
        { actor: { by: by.email }, log: app.log },
        { topic, id: document.id, level },
      );
    },
    onError: (err, message) => app.log.error({ err }, message),
  });
