import { randomUUID } from 'node:crypto';
import type { Readable } from 'node:stream';
import {
  isYoutubeUrl,
  type CreateDocumentUploadRequest,
  type CreateDocumentUploadResponse,
  type DocumentUpload,
  type LevelChoice,
  type UploadedDocumentRef,
} from '@kb-chat/contracts';
import { AppError } from '../../app-error.js';
import type {
  DocumentUploadFilesPort,
  DocumentUploadRecord,
  UploadOwner,
} from '../../ports/document-uploads.js';
import { UploadRefusedError } from '../../ports/media-files.js';
import { chosenLevel, type MediaActor } from '../media/index.js';
import type { UploadRecords } from './upload-records.js';
import { toDocumentUpload, type MediaProgress } from './upload-view.js';

/** Who sends: the media library's actor (BR-1: the same permission) plus the audit's name. */
export interface UploadActor extends MediaActor {
  readonly email: string;
  /** Whether a document of the collection is one this person may see (its level, ADR 0036). */
  readonly seesDocument: (topic: string, id: string) => boolean;
}

/** A document already in the collection, found by its original's hash or its link. */
export interface ExistingDocument {
  readonly topic: string;
  readonly document: UploadedDocumentRef;
}

export interface DocumentUploadServiceDeps {
  readonly records: UploadRecords;
  readonly files: DocumentUploadFilesPort;
  /** The collection exists in the vault (a screen-only one has no folder for kb yet). */
  readonly hasTopic: (topic: string) => boolean;
  /** The collection and its sub-collections, for "already in the collection" (ADR 0028). */
  readonly scopeOf: (topic: string) => readonly string[];
  readonly scaleOf: (topic: string) => readonly LevelChoice[];
  /** The catalog's document made from this original or this link, in the scope. */
  readonly findExisting: (
    scope: readonly string[],
    key: { readonly sha256: string | null; readonly url: string | null },
  ) => ExistingDocument | null;
  /** The document is in the app's catalog (the sync brought it): the upload is "pronto". */
  readonly inCatalog: (topic: string, id: string) => boolean;
  /** Where a YouTube link's media item is now. */
  readonly mediaProgressOf?: (mediaId: string) => MediaProgress | null;
  /** A job is waiting: the Mac is started when it runs only on demand (KBC-114). */
  readonly wake?: () => void;
  readonly now?: () => Date;
}

/** Uploads listed in "Documentos em processamento": the newest, at most this many. */
const LIST_LIMIT = 100;
/** A file whose bytes stopped arriving this long ago is given up (as media, ADR 0033). */
export const DOCUMENT_UPLOAD_ABANDON_MS = 7 * 24 * 60 * 60 * 1000;

const notFound = () => new AppError('NOT_FOUND', 'No such document upload');
const notWaiting = () =>
  new AppError('MEDIA_CONFLICT', 'This upload is not waiting for this part');

/**
 * People's side of documents and links sent from the app (KBC-149, ADR 0040): announce a
 * file or send a link, the file's bytes by tus, and the list of what is on its way. The API
 * keeps the file and the job; only the Mac converts and writes the vault (BR-2, Q7).
 */
export class DocumentUploadService {
  private readonly now: () => Date;
  /** One part at a time per upload: a second one waits its turn by a 409. */
  private readonly receiving = new Set<string>();

  constructor(private readonly deps: DocumentUploadServiceDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  async create(
    actor: UploadActor,
    topic: string,
    request: CreateDocumentUploadRequest,
  ): Promise<CreateDocumentUploadResponse> {
    if (!actor.canUpload)
      throw new AppError('FORBIDDEN', 'You may not send documents');
    if (!actor.canSee(topic) || !this.deps.hasTopic(topic))
      throw new AppError('TOPIC_NOT_FOUND', `Unknown topic ${topic}`);
    const level = chosenLevel(actor, {
      topic,
      scale: this.deps.scaleOf(topic),
      asked: request.level,
    });
    const key = keyOf(request);
    const repeated = this.repeated(actor, topic, key);
    if (repeated) return repeated;
    const record = this.newRecord(actor, { topic, request, level });
    await this.deps.records.put(record);
    if (record.state === 'received') this.deps.wake?.();
    return { outcome: 'created', upload: await this.viewOf(record, actor) };
  }

  /** BR-3: the same original (or link) in the collection, or on its way, is not sent again. */
  private repeated(
    actor: UploadActor,
    topic: string,
    key: UploadKey,
  ): CreateDocumentUploadResponse | null {
    const scope = this.deps.scopeOf(topic);
    const existing = this.deps.findExisting(scope, key);
    if (existing) {
      const seen = actor.seesDocument(existing.topic, existing.document.id);
      const document = seen ? existing.document : null;
      return { outcome: 'duplicate', document, upload: null };
    }
    const pending = this.deps.records
      .all()
      .find((one) => scope.includes(one.topic) && isSameLive(one, key));
    if (!pending) return null;
    const mine = pending.owner.principal === actor.principal || actor.isMaster;
    const upload = mine ? this.viewNow(pending, actor, null) : null;
    return { outcome: 'duplicate', document: upload?.document ?? null, upload };
  }

  private newRecord(
    actor: UploadActor,
    input: {
      topic: string;
      request: CreateDocumentUploadRequest;
      level: string | null;
    },
  ): DocumentUploadRecord {
    const at = this.now().toISOString();
    return {
      id: randomUUID(),
      topic: input.topic,
      ...sourceOf(input.request),
      level: input.level,
      owner: ownerOf(actor),
      failure: null,
      detail: null,
      document: null,
      mediaId: null,
      lease: null,
      attempts: 0,
      spentUsd: 0,
      createdAt: at,
      updatedAt: at,
    };
  }

  /** HEAD …/upload: how much arrived (tus). */
  async uploadStatus(
    actor: UploadActor,
    id: string,
  ): Promise<{ offset: number; length: number }> {
    const record = this.ownReceiving(actor, id);
    return {
      offset: await this.deps.files.offset(id),
      length: record.bytes ?? 0,
    };
  }

  /** PATCH …/upload: one part at the offset the server has; the whole file is checked. */
  async receivePart(
    actor: UploadActor,
    id: string,
    part: { readonly body: Readable; readonly offset: number },
  ): Promise<number> {
    const record = this.ownReceiving(actor, id);
    if (this.receiving.has(id)) throw notWaiting();
    this.receiving.add(id);
    try {
      if ((await this.deps.files.offset(id)) !== part.offset)
        throw notWaiting();
      const bytes = record.bytes ?? 0;
      const offset = await this.append(id, part.body, bytes);
      if (offset === bytes) return await this.finish(record);
      return offset;
    } finally {
      this.receiving.delete(id);
    }
  }

  private async append(id: string, body: Readable, bytes: number) {
    try {
      return await this.deps.files.append(id, body, bytes);
    } catch (err) {
      if (err instanceof UploadRefusedError && err.problem === 'too-large')
        throw new AppError(
          'PAYLOAD_TOO_LARGE',
          'The file is larger than announced',
        );
      throw err;
    }
  }

  /** Every byte arrived: a different file starts over; the same one goes to the Mac. */
  private async finish(record: DocumentUploadRecord): Promise<number> {
    if ((await this.deps.files.sha256(record.id)) !== record.sha256) {
      await this.deps.files.remove(record.id);
      return 0;
    }
    await this.deps.records.put({
      ...record,
      state: 'received',
      updatedAt: this.now().toISOString(),
    });
    this.deps.wake?.();
    return record.bytes ?? 0;
  }

  private ownReceiving(actor: UploadActor, id: string): DocumentUploadRecord {
    const record = this.deps.records.get(id);
    if (!record || record.owner.principal !== actor.principal) throw notFound();
    if (record.state !== 'receiving') throw notWaiting();
    return record;
  }

  /** "Documentos em processamento": one's own; masters see everyone's. */
  async list(actor: UploadActor): Promise<DocumentUpload[]> {
    await this.giveUpAbandoned();
    const records = this.deps.records
      .all()
      .filter(
        (one) =>
          (actor.isMaster || one.owner.principal === actor.principal) &&
          actor.canSee(one.topic),
      )
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, LIST_LIMIT);
    return Promise.all(records.map((one) => this.viewOf(one, actor)));
  }

  /** A file whose bytes stopped arriving a week ago is given up; its part is removed. */
  private async giveUpAbandoned(): Promise<void> {
    const limit = this.now().getTime() - DOCUMENT_UPLOAD_ABANDON_MS;
    const stale = this.deps.records
      .all()
      .filter(
        (one) => one.state === 'receiving' && Date.parse(one.updatedAt) < limit,
      );
    for (const record of stale) {
      await this.deps.files.remove(record.id);
      await this.deps.records.put({
        ...record,
        state: 'failed',
        failure: 'upload-abandoned',
        updatedAt: this.now().toISOString(),
      });
    }
  }

  private async viewOf(
    record: DocumentUploadRecord,
    actor: UploadActor,
  ): Promise<DocumentUpload> {
    const received =
      record.kind === 'file'
        ? record.state === 'receiving'
          ? await this.deps.files.offset(record.id)
          : record.bytes
        : null;
    return this.viewNow(record, actor, received);
  }

  private viewNow(
    record: DocumentUploadRecord,
    actor: UploadActor,
    received: number | null,
  ): DocumentUpload {
    const media =
      record.mediaId && this.deps.mediaProgressOf
        ? this.deps.mediaProgressOf(record.mediaId)
        : null;
    const arrived =
      record.document !== null &&
      this.deps.inCatalog(record.topic, record.document.id);
    const view = toDocumentUpload(record, {
      showsDetail: actor.isMaster,
      received,
      media,
      arrived,
    });
    // A document above the person's level is not named, even as their own upload's result.
    const document =
      view.document && actor.seesDocument(record.topic, view.document.id)
        ? view.document
        : null;
    return { ...view, document };
  }
}

interface UploadKey {
  readonly sha256: string | null;
  readonly url: string | null;
}

/** An upload of the same original (or link) that did not fail: on its way, or done. */
const isSameLive = (one: DocumentUploadRecord, key: UploadKey): boolean =>
  one.state !== 'failed' &&
  ((key.sha256 !== null && one.sha256 === key.sha256) ||
    (key.url !== null && one.url === key.url));

/** What an upload is, from what was sent: a file waits for its bytes, a link for the Mac. */
function sourceOf(
  request: CreateDocumentUploadRequest,
): Pick<
  DocumentUploadRecord,
  'kind' | 'name' | 'url' | 'sha256' | 'bytes' | 'state'
> {
  if (request.kind === 'file')
    return {
      kind: 'file',
      name: request.name,
      url: null,
      sha256: request.sha256,
      bytes: request.bytes,
      state: 'receiving',
    };
  return {
    kind: isYoutubeUrl(request.url) ? 'youtube' : 'url',
    name: request.url,
    url: request.url,
    sha256: null,
    bytes: null,
    state: 'received',
  };
}

const keyOf = (request: CreateDocumentUploadRequest): UploadKey => ({
  sha256: request.kind === 'file' ? request.sha256 : null,
  url: request.kind === 'url' ? request.url : null,
});

const ownerOf = (actor: UploadActor): UploadOwner => ({
  principal: actor.principal,
  email: actor.email,
  isMaster: actor.isMaster,
  quotaBytes: actor.quotaBytes ?? null,
  displayName: actor.displayName ?? null,
});
