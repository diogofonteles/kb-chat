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
import type { RemovalRecord } from './ports/document-removals.js';
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
  const service = removalService(app, wiring);
  await app.register(
    documentRemovalRoutes({
      service,
      actorOf: (request) => actorOf(app, request, catalog),
    }),
  );
  const moved = refreshSoon((topic) => catalog.refresh(topic), {
    onError: (err) =>
      app.log.warn({ err }, 'document removals: a collection was not read'),
  });
  const jobs = new VaultJobs({
    docs: wiring.docs,
    removals: removalQueue(app, wiring, moved),
    entered: async (jobId, documentId) => {
      const topic = uploads.topicOf(jobId);
      const removed = topic ? records.of(topic, documentId) : undefined;
      if (!removed || !cameBack(removed)) return;
      await records.remove(removed.id);
      moved(removed.topic);
    },
  });
  wiring.onDocIngest?.(jobs);
  return jobs;
}

const removalService = (
  app: FastifyInstance,
  wiring: DocumentRemovalsWiring,
): RemovalService =>
  new RemovalService({
    records: wiring.records,
    catalog: wiring.catalog,
    levelOf: (topic, id) =>
      wiring.levels.directory.placementsOf(topic)[id]?.level ?? null,
    placeLevel: (record) => placeLevel(app, wiring, record),
    done: (what, record, by) =>
      app.log.info(
        { what, by, topic: record.topic, document: record.document.id },
        'document removal',
      ),
  });

/** A master: what they see is theirs to take out. */
function actorOf(
  app: FastifyInstance,
  request: FastifyRequest,
  catalog: CatalogRegistry,
): RemovalActor {
  const { person, principal } = viewerOf(request);
  const parentOf = app.topicParentOf ?? NO_PARENT;
  return {
    principal,
    email: person.email,
    name: person.name ?? '',
    canSee: (topic) => canSeeTopic(person, topic, parentOf),
    seesDocument: uploadActorOf(request, catalog).seesDocument,
  };
}

/**
 * Sent again, it is there: the Mac had taken it and brought it back, or could not take it. One
 * asked for while the document was entering stands.
 */
const cameBack = ({ isQuarantined, failed }: RemovalRecord): boolean =>
  isQuarantined === true || failed;

const removalQueue = (
  app: FastifyInstance,
  { records, levels }: DocumentRemovalsWiring,
  moved: (topic: string) => void,
): RemovalQueue =>
  new RemovalQueue({
    records,
    moved,
    placeLevel: (record) => placeLevel(app, { levels }, record),
    onError: (err, message) => app.log.error({ err }, message),
  });

async function placeLevel(
  app: FastifyInstance,
  { levels }: Pick<DocumentRemovalsWiring, 'levels'>,
  { topic, document, level, by }: RemovalRecord,
): Promise<void> {
  // It still has it, or was placed anew: nothing to say in the levels' audit.
  const now = levels.directory.placementsOf(topic)[document.id]?.level;
  if (level === null || now !== undefined) return;
  await levels.documents.placeArriving(
    { actor: { by: by.email }, log: app.log },
    { topic, id: document.id, level },
  );
}
