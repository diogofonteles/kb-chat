import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Readable } from 'node:stream';
import { FsDocumentUploadFiles } from './adapters/fs-document-upload-files.js';
import { JsonDocumentUploadStore } from './adapters/json-document-upload-store.js';
import { startOfAppMonth } from './app-calendar.js';
import type { AppConfig } from './config.js';
import type { MediaDeps } from './media-factory.js';
import type { MediaDocuments } from './media-documents-factory.js';
import { sameLinkKey } from '@kb-chat/contracts';
import { collectionOf } from './modules/media-documents/index.js';
import { refreshSoon } from './refresh-soon.js';
import type { DocumentUploadRecord } from './ports/document-uploads.js';
import {
  levelViewOf,
  type DocumentLevelsService,
} from './modules/access-levels/index.js';
import {
  NO_PARENT,
  canSeeTopic,
  hasFeature,
  isMaster,
  mediaQuotaOf,
  viewerOf,
  type PeopleService,
} from './modules/auth/index.js';
import type { CatalogEntry, CatalogRegistry } from './modules/catalog/index.js';
import {
  DocIngestQueue,
  DocumentUploadService,
  UploadRecords,
  documentUploadRoutes,
  type ExistingDocument,
  type MediaProgress,
  type UploadActor,
} from './modules/document-uploads/index.js';
import {
  actorOf as mediaActorOf,
  type MediaActor,
  type MediaService,
} from './modules/media/index.js';

/** What sending documents from the app is built from (KBC-149, ADR 0040). */
export interface DocumentUploadsWiring {
  readonly config: AppConfig;
  readonly catalog: CatalogRegistry;
  readonly media: MediaDeps;
  readonly mediaService: MediaService;
  readonly documents: MediaDocuments;
  readonly people: PeopleService;
  readonly levels: {
    readonly documents: DocumentLevelsService;
    readonly scaleOf: (
      topic: string,
    ) => readonly { id: string; code: string }[];
  };
}

/**
 * Documents and links sent from the app: people's routes, and the doc-ingest queue the Mac
 * leases through the worker routes. Returns the queue for the worker side and the waker.
 */
export async function registerDocumentUploads(
  app: FastifyInstance,
  wiring: DocumentUploadsWiring,
): Promise<DocIngestQueue> {
  const state = wiring.config.KB_CHAT_STATE_DIR;
  const records = await UploadRecords.open(
    new JsonDocumentUploadStore(join(state, 'document-uploads.json')),
  );
  const files = new FsDocumentUploadFiles(join(state, 'document-uploads'));
  const service = uploadService(wiring, { records, files });
  keepSwept(app, service);
  await app.register(
    documentUploadRoutes({
      service,
      actorOf: (request) => uploadActorOf(request, wiring.catalog),
      createPerMinute: wiring.config.DOCUMENT_CREATE_RATE_LIMIT,
    }),
  );
  return ingestQueue(app, wiring, { records, files });
}

/** What is old leaves by itself (PD-11), at the start and then now and then. */
const SWEEP_MS = 6 * 60 * 60 * 1000;

function keepSwept(app: FastifyInstance, service: DocumentUploadService): void {
  const sweep = () => {
    service
      .sweep()
      .catch((err: unknown) =>
        app.log.warn({ err }, 'document uploads: the sweep failed'),
      );
  };
  sweep();
  const timer = setInterval(sweep, SWEEP_MS);
  timer.unref();
  app.addHook('onClose', () => clearInterval(timer));
}

function ingestQueue(
  app: FastifyInstance,
  wiring: DocumentUploadsWiring,
  stores: { records: UploadRecords; files: FsDocumentUploadFiles },
): DocIngestQueue {
  return new DocIngestQueue({
    ...stores,
    budgetUsd: () => wiring.documents.kb.budgetUsd(),
    // A collection made on the screen gets its vault folder with its first document (R2).
    collectionOf: (topic) =>
      collectionOf(
        wiring.catalog.topics().map((one) => one.topic),
        topic,
      ),
    written: refreshSoon((topic) => wiring.catalog.refresh(topic), {
      onError: (err) =>
        app.log.warn({ err }, 'document uploads: the collection was not read'),
    }),
    placeLevel: (record, id) => placeLevel(app, wiring, { record, id }),
    book: (record, usd) => book(wiring.media, { record, usd }),
    adoptAudio: (record, audio) => adoptAudio(app, wiring, { record, audio }),
    onError: (err, message) => app.log.error({ err }, message),
  });
}

function uploadService(
  wiring: DocumentUploadsWiring,
  stores: { records: UploadRecords; files: FsDocumentUploadFiles },
): DocumentUploadService {
  const { catalog } = wiring;
  return new DocumentUploadService({
    ...stores,
    hasTopic: (topic) => catalog.get(topic) !== undefined,
    scopeOf: (topic) => catalog.scope(topic).map((one) => one.topic.slug),
    scaleOf: wiring.levels.scaleOf,
    findExisting: (scope, key) => findExisting(catalog, scope, key),
    inCatalog: (topic, id) => catalog.get(topic)?.entries.has(id) === true,
    mediaProgressOf: (mediaId) => mediaProgressOf(wiring, mediaId),
    monthLeftUsd: () => wiring.documents.kb.budgetUsd(),
  });
}

/** BR-1: the media library's actor, plus the audit's name and the level of what it names. */
function uploadActorOf(
  request: FastifyRequest,
  catalog: CatalogRegistry,
): UploadActor {
  const viewer = viewerOf(request);
  return {
    ...mediaActorOf(request),
    email: viewer.person.email,
    seesDocument: (topic, id) => {
      const entry = catalog.get(topic)?.entries.get(id);
      return (
        entry !== undefined && levelViewOf(request, topic).allows(topic, entry)
      );
    },
  };
}

/** The catalog's document made from the same original (by hash) or the same link. */
function findExisting(
  catalog: CatalogRegistry,
  scope: readonly string[],
  key: { readonly sha256: string | null; readonly url: string | null },
): ExistingDocument | null {
  const same = (entry: CatalogEntry) =>
    (key.sha256 !== null && entry.original?.sha256 === key.sha256) ||
    (key.url !== null &&
      entry.sourcePath !== null &&
      sameLinkKey(entry.sourcePath) === key.url);
  for (const topic of scope) {
    const entries = [...(catalog.get(topic)?.entries.values() ?? [])];
    const entry = entries.find(same);
    if (entry) return { topic, document: { id: entry.id, title: entry.title } };
  }
  return null;
}

/** A recording link's media item: failed, live in the collection (ready), or on its way. */
function mediaProgressOf(
  wiring: DocumentUploadsWiring,
  mediaId: string,
): MediaProgress | null {
  const media = wiring.media.store.getMedia(mediaId);
  if (!media) return null;
  if (media.status === 'failed') return 'failed';
  const publication = wiring.documents.status.of(mediaId);
  if (publication?.state === 'live') return 'ready';
  if (publication?.state === 'failed') return 'failed';
  return 'transcribing';
}

/** ADR 0036 §5: the document is placed at its level before it arrives (audited). */
async function placeLevel(
  app: FastifyInstance,
  wiring: DocumentUploadsWiring,
  input: { record: DocumentUploadRecord; id: string },
): Promise<void> {
  const { record, id } = input;
  if (!record.level) return;
  const placed = await wiring.levels.documents.placeArriving(
    { actor: { by: record.owner.email }, log: app.log },
    { topic: record.topic, id, level: record.level },
  );
  if (!placed)
    app.log.warn(
      { upload: record.id, topic: record.topic, level: record.level },
      'document upload: its level is gone, the document arrives without one',
    );
}

/** kb's spend on a sent document, settled on the media month (ADR 0035 §11). */
function book(
  media: MediaDeps,
  input: { record: DocumentUploadRecord; usd: number },
): void {
  const now = new Date();
  const id = randomUUID();
  media.spend.reserve({
    id,
    kind: 'kb-publish',
    mediaId: input.record.id,
    principal: input.record.owner.principal,
    usd: input.usd,
    // Already spent on kb's own key: booked whatever the cap says, never lost.
    capUsd: Number.MAX_VALUE,
    since: startOfAppMonth(now),
    now,
  });
  media.spend.close({ id, spentUsd: input.usd, outcome: 'settled', now });
}

/**
 * KBC-142 BR-5: a recording link's audio becomes the sender's recording, with their rights as
 * they stand now (a person removed or without "media-upload" since gets nothing).
 */
async function adoptAudio(
  app: FastifyInstance,
  wiring: DocumentUploadsWiring,
  input: {
    record: DocumentUploadRecord;
    audio: { body: Readable; bytes: number; name: string };
  },
): Promise<string> {
  const { record, audio } = input;
  const actor = await senderAsTheyStand(app, wiring, record.owner.principal);
  if (!actor.canUpload || !actor.canSee(record.topic))
    throw new Error(
      'the sender of this link may no longer send to this collection',
    );
  const item = wiring.mediaService.create(actor, record.topic, {
    title: titleOfRecording(audio.name),
    author: null,
    fileName: audio.name,
    bytes: audio.bytes,
    ...(record.level && { level: record.level }),
  });
  await wiring.mediaService.receiveFile(actor, item.id, {
    body: audio.body,
    declaredBytes: audio.bytes,
  });
  return item.id;
}

async function senderAsTheyStand(
  app: FastifyInstance,
  wiring: DocumentUploadsWiring,
  principal: string,
): Promise<MediaActor> {
  const { people } = wiring;
  const person = (await people.list()).find(
    (one) => people.viewerOf(one).principal === principal,
  );
  if (!person)
    throw new Error('the sender of this link is no longer a person here');
  const viewer = people.viewerOf(person);
  const parentOf = app.topicParentOf ?? NO_PARENT;
  return {
    principal,
    isMaster: isMaster(person),
    canUpload: hasFeature(person, 'media-upload'),
    quotaBytes: mediaQuotaOf(viewer),
    displayName: person.name,
    canSee: (topic) => canSeeTopic(person, topic, parentOf),
    // Without the gate, nothing (fail-closed); a collection without levels answers null.
    levelsIn: (topic) => {
      const gate = app.contentGate;
      return gate ? gate.viewFor(person, topic).allowedLevelIds() : [];
    },
  };
}

/** The recording's own title, from the file the Mac named after it ("Título [id].m4a"). */
export const titleOfRecording = (fileName: string): string =>
  fileName
    .replace(/\.[a-z0-9]+$/i, '')
    .replace(/\s*\[[^\][]*\]$/, '')
    .trim()
    .slice(0, 200) || 'Gravação';
