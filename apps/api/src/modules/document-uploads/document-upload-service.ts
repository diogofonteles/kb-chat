import { randomUUID } from 'node:crypto';
import type { Readable } from 'node:stream';
import {
  DOCUMENT_BATCH_DEFAULT_USD,
  DOCUMENT_DISK_RESERVE_BYTES,
  DOCUMENT_WAITING_MAX_BYTES,
  recordingLinkKind,
  sameLinkKey,
  type ContentCosts,
  type ChooseRecordingsRequest,
  type ChooseRecordingsResponse,
  type CreateDocumentUploadRequest,
  type CreateDocumentUploadResponse,
  type DocumentBatch,
  type DocumentUpload,
  type LevelChoice,
  type UploadedDocumentRef,
} from '@kb-chat/contracts';
import { AppError } from '../../app-error.js';
import type {
  DocumentUploadFilesPort,
  DocumentUploadRecord,
  UploadBatch,
  UploadOwner,
} from '../../ports/document-uploads.js';
import { UploadRefusedError } from '../../ports/media-files.js';
import { chosenLevel, type MediaActor } from '../media/index.js';
import { contentCostsOf } from './content-costs.js';
import { BatchLedger, MIN_LEASE_USD, isWorking } from './upload-batches.js';
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
  /** Where a recording link's media item is now. */
  readonly mediaProgressOf?: (mediaId: string) => MediaProgress | null;
  /** What the media month still has (ADR 0035 §11): at zero, everything waits. */
  readonly monthLeftUsd?: () => number;
  readonly now?: () => Date;
}

/** Uploads listed in "Documentos em processamento": a folder or two, the newest first. */
const LIST_LIMIT = 1_000;
/** A file whose bytes stopped arriving this long ago is given up (as media, ADR 0033). */
export const DOCUMENT_UPLOAD_ABANDON_MS = 7 * 24 * 60 * 60 * 1000;
/** What ended this long ago leaves the record: the collection itself answers for it. */
export const DOCUMENT_UPLOAD_KEEP_MS = 90 * 24 * 60 * 60 * 1000;

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
    const batch = this.batchFor(actor, request);
    const resumed = await this.resume(actor, { topic, key, level, batch });
    if (resumed)
      return { outcome: 'created', upload: await this.viewOf(resumed, actor) };
    if (request.kind === 'file') await this.assertRoom(actor, request.bytes);
    const record = this.newRecord(actor, { topic, request, level, batch });
    await this.deps.records.put(record);
    return { outcome: 'created', upload: await this.viewOf(record, actor) };
  }

  /**
   * The person's own file that stopped half-way, sent again to the same collection: its bytes
   * go on from where they are, with the level and the inclusion chosen now.
   */
  private async resume(
    actor: UploadActor,
    input: {
      readonly topic: string;
      readonly key: UploadKey;
      readonly level: string | null;
      readonly batch: UploadBatch;
    },
  ): Promise<DocumentUploadRecord | undefined> {
    const { topic, key, level, batch } = input;
    const stopped = this.deps.records
      .all()
      .find(
        (one) =>
          one.state === 'receiving' &&
          one.topic === topic &&
          one.owner.principal === actor.principal &&
          isSame(one, key),
      );
    if (!stopped) return undefined;
    return this.deps.records.update(stopped.id, (current) => ({
      ...current,
      level,
      batch,
      updatedAt: this.now().toISOString(),
    }));
  }

  /** A person's files waiting here are bounded, and the disk keeps its reserve (PD-11). */
  private async assertRoom(actor: UploadActor, bytes: number): Promise<void> {
    const waiting = this.deps.records
      .all()
      .filter(
        (one) =>
          one.owner.principal === actor.principal && this.holdsBytes(one),
      )
      .reduce((sum, one) => sum + (one.bytes ?? 0), 0);
    if (!actor.isMaster && waiting + bytes > DOCUMENT_WAITING_MAX_BYTES)
      throw new AppError(
        'MEDIA_QUOTA_EXCEEDED',
        'Too many files waiting here',
        { details: { quotaBytes: DOCUMENT_WAITING_MAX_BYTES } },
      );
    const free = await this.deps.files.freeBytes();
    if (free - bytes < DOCUMENT_DISK_RESERVE_BYTES)
      throw new AppError('STORAGE_FULL', 'No room left for files');
  }

  /**
   * Whether a link is already in the collection or on its way (KBC-185), without sending it:
   * what `create` would answer. The document is named only to who sees it, by its id in the
   * collection asked about (a sub-collection's is under its folder, ADR 0028).
   */
  presenceOf(
    actor: UploadActor,
    topic: string,
    url: string,
  ): { document: UploadedDocumentRef | null } | null {
    const key = { sha256: null, url: sameLinkKey(url) };
    const repeated = this.repeated(actor, topic, key);
    if (repeated?.outcome !== 'duplicate') return null;
    return { document: repeated.document };
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
      const document = seen ? inScope(topic, existing) : null;
      return { outcome: 'duplicate', document, upload: null };
    }
    const pending = this.deps.records
      .all()
      .find(
        (one) =>
          scope.includes(one.topic) && isSame(one, key) && this.isLive(one),
      );
    if (!pending) return null;
    const mine = pending.owner.principal === actor.principal || actor.isMaster;
    const upload = mine
      ? this.viewNow(pending, actor, {
          received: null,
          kept: false,
          ledger: this.ledger(),
        })
      : null;
    return { outcome: 'duplicate', document: upload?.document ?? null, upload };
  }

  /** Its file is here: arriving, waiting for the Mac, or kept after it failed. */
  private holdsBytes(record: DocumentUploadRecord): boolean {
    if (record.kind !== 'file' || record.state === 'mapped') return false;
    if (record.state !== 'failed') return true;
    const age = this.now().getTime() - Date.parse(record.updatedAt);
    return (
      record.failure !== 'upload-abandoned' && age <= DOCUMENT_UPLOAD_ABANDON_MS
    );
  }

  /**
   * Received and not failed: it is in the collection or on its way. One still receiving its
   * bytes blocks nobody (its sender may never come back), nor does a recording that failed.
   */
  private isLive(record: DocumentUploadRecord): boolean {
    if (record.state === 'failed' || record.state === 'receiving') return false;
    if (!record.mediaId || !this.deps.mediaProgressOf) return true;
    const progress = this.deps.mediaProgressOf(record.mediaId);
    return progress !== null && progress !== 'failed';
  }

  /**
   * The inclusion the item enters (R3): the one the person is sending, with the ceiling it
   * already has; a new one otherwise. Someone else's inclusion is never joined.
   */
  private batchFor(
    actor: UploadActor,
    request: CreateDocumentUploadRequest,
  ): UploadBatch {
    const asked = request.batch;
    if (!asked) return { id: randomUUID(), capUsd: DOCUMENT_BATCH_DEFAULT_USD };
    const same = this.deps.records
      .all()
      .find((one) => one.batch?.id === asked.id);
    if (same && same.owner.principal !== actor.principal) throw notFound();
    return { id: asked.id, capUsd: same?.batch?.capUsd ?? asked.capUsd };
  }

  /** A new ceiling for an inclusion (its sender, or a master): what waited goes on. */
  async changeBatch(
    actor: UploadActor,
    id: string,
    capUsd: number,
  ): Promise<DocumentBatch> {
    const items = this.deps.records
      .all()
      .filter((one) => one.batch?.id === id && this.mayManage(actor, one));
    if (items.length === 0) throw notFound();
    await this.deps.records.put(
      ...items.map((one) => ({ ...one, batch: { id, capUsd } })),
    );
    const changed = this.ledger().viewOf(id);
    if (!changed) throw notFound();
    return changed;
  }

  /**
   * Takes an item out: one that did not reach the Mac is cancelled, one that ended leaves the
   * list (its document stays). While the Mac works on it, 409.
   */
  async remove(actor: UploadActor, id: string): Promise<void> {
    const record = this.deps.records.get(id);
    if (!record || !this.mayManage(actor, record)) throw notFound();
    if (isWorking(record, this.now()) || this.receiving.has(id))
      throw new AppError('MEDIA_CONFLICT', 'The Mac is working on it');
    await this.deps.files.remove(id);
    // What it spent still counts in its inclusion, and what it became is still there.
    if (record.spentUsd > 0 || record.state === 'mapped')
      await this.deps.records.update(id, (one) => ({
        ...one,
        dismissed: true,
      }));
    else await this.deps.records.remove(id);
  }

  /**
   * The list's recordings that enter (KBC-186 R7): each one an item of the list's inclusion,
   * at its level; what is already there counts apart. The list itself is done.
   */
  async choose(
    actor: UploadActor,
    id: string,
    request: ChooseRecordingsRequest,
  ): Promise<ChooseRecordingsResponse> {
    const list = this.deps.records.get(id);
    if (!list || !this.mayManage(actor, list)) throw notFound();
    if (list.state !== 'choosing') throw notWaiting();
    const offered = new Set(list.entries.map((one) => one.url));
    const urls = [...new Set(request.urls)];
    if (!urls.every((url) => offered.has(url)))
      throw new AppError('VALIDATION_FAILED', 'Not a recording of this list', {
        details: { field: 'urls' },
      });
    // The list leaves first: a second press finds nothing to choose from.
    await this.deps.records.remove(id);
    const fresh = urls.filter(
      (url) =>
        !this.repeated(actor, list.topic, {
          sha256: null,
          url: sameLinkKey(url),
        }),
    );
    await this.deps.records.put(
      ...fresh.map((url) => this.chosenOf(list, url)),
    );
    return { created: fresh.length, already: urls.length - fresh.length };
  }

  private chosenOf(
    list: DocumentUploadRecord,
    url: string,
  ): DocumentUploadRecord {
    const at = this.now().toISOString();
    return {
      ...list,
      id: randomUUID(),
      kind: 'recording',
      name: list.entries.find((one) => one.url === url)?.title ?? url,
      url,
      state: 'received',
      attempts: 0,
      spentUsd: 0,
      entries: [],
      createdAt: at,
      updatedAt: at,
    };
  }

  /** What each kind took here, for the estimate shown before anything is sent (KBC-186). */
  costs(): ContentCosts {
    return contentCostsOf(this.deps.records.all());
  }

  /** A failed item goes again as it was sent, with its attempts renewed. */
  async retry(actor: UploadActor, id: string): Promise<DocumentUpload> {
    const record = this.deps.records.get(id);
    if (!record || !this.mayManage(actor, record)) throw notFound();
    if (record.state !== 'failed' || !(await this.isKept(record)))
      throw notWaiting();
    const again = await this.deps.records.update(id, (current) => ({
      ...current,
      state: 'received',
      failure: null,
      detail: null,
      attempts: 0,
      updatedAt: this.now().toISOString(),
    }));
    if (!again) throw notFound();
    return this.viewOf(again, actor);
  }

  /** A link is always there; a file, while its bytes are. */
  private async isKept(record: DocumentUploadRecord): Promise<boolean> {
    if (record.kind !== 'file') return true;
    if (record.failure === 'upload-abandoned') return false;
    return (await this.deps.files.find(record.id)) !== null;
  }

  private mayManage(actor: UploadActor, record: DocumentUploadRecord): boolean {
    return (
      actor.canSee(record.topic) &&
      (actor.isMaster || record.owner.principal === actor.principal)
    );
  }

  private newRecord(
    actor: UploadActor,
    input: {
      topic: string;
      request: CreateDocumentUploadRequest;
      level: string | null;
      batch: UploadBatch;
    },
  ): DocumentUploadRecord {
    const at = this.now().toISOString();
    return {
      ...NEW_RECORD,
      ...sourceOf(input.request),
      id: randomUUID(),
      topic: input.topic,
      level: input.level,
      batch: input.batch,
      owner: ownerOf(actor),
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
    await this.deps.records.update(record.id, (current) => ({
      ...current,
      state: 'received',
      updatedAt: this.now().toISOString(),
    }));
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
    const records = this.deps.records
      .all()
      .filter(
        (one) =>
          !one.dismissed &&
          (actor.isMaster || one.owner.principal === actor.principal) &&
          actor.canSee(one.topic),
      )
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, LIST_LIMIT);
    const ledger = this.ledger();
    return Promise.all(records.map((one) => this.viewOf(one, actor, ledger)));
  }

  private ledger(): BatchLedger {
    return new BatchLedger(this.deps.records.all(), this.now());
  }

  /**
   * A week on: bytes that stopped arriving are given up, and a failed file's bytes go. Three
   * months on, what ended leaves the record. Run by the API now and then.
   */
  async sweep(): Promise<void> {
    const now = this.now();
    const since = (record: DocumentUploadRecord) =>
      now.getTime() - Date.parse(record.updatedAt);
    const all = this.deps.records.all();
    const ended = all.filter(
      (one) =>
        ['mapped', 'failed', 'transcribing'].includes(one.state) &&
        since(one) > DOCUMENT_UPLOAD_KEEP_MS,
    );
    if (ended.length > 0)
      await this.deps.records.remove(...ended.map((one) => one.id));
    for (const record of all) {
      if (since(record) <= DOCUMENT_UPLOAD_ABANDON_MS) continue;
      if (record.state !== 'failed' && record.state !== 'receiving') continue;
      await this.deps.files.remove(record.id);
      if (record.state === 'receiving') await this.giveUp(record.id, now);
    }
  }

  private async giveUp(id: string, now: Date): Promise<void> {
    await this.deps.records.update(id, (current) => ({
      ...current,
      state: 'failed',
      failure: 'upload-abandoned',
      updatedAt: now.toISOString(),
    }));
  }

  private async viewOf(
    record: DocumentUploadRecord,
    actor: UploadActor,
    ledger = this.ledger(),
  ): Promise<DocumentUpload> {
    const received =
      record.kind === 'file'
        ? record.state === 'receiving'
          ? await this.deps.files.offset(record.id)
          : record.bytes
        : null;
    const kept = record.state === 'failed' && (await this.isKept(record));
    return this.viewNow(record, actor, { received, kept, ledger });
  }

  private viewNow(
    record: DocumentUploadRecord,
    actor: UploadActor,
    known: KnownOfUpload,
  ): DocumentUpload {
    const media =
      record.mediaId && this.deps.mediaProgressOf
        ? this.deps.mediaProgressOf(record.mediaId)
        : null;
    const arrived =
      record.document !== null &&
      this.deps.inCatalog(record.topic, record.document.id);
    const view = toDocumentUpload(record, {
      ...this.contextOf(record, actor, known),
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

  private contextOf(
    record: DocumentUploadRecord,
    actor: UploadActor,
    known: KnownOfUpload,
  ) {
    return {
      showsDetail: actor.isMaster,
      received: known.received,
      kept: known.kept,
      batch: record.batch ? known.ledger.viewOf(record.batch.id) : null,
      heldBy: this.heldBy(record, known.ledger),
      mine: record.owner.principal === actor.principal,
    };
  }

  /**
   * The ceiling a waiting item is behind: its inclusion's (what was really spent of it, not
   * what the Mac holds for another item), or the media month's.
   */
  private heldBy(
    record: DocumentUploadRecord,
    ledger: BatchLedger,
  ): DocumentUpload['heldBy'] {
    if (ledger.unspentOf(record) < MIN_LEASE_USD) return 'batch-cap';
    const month = this.deps.monthLeftUsd?.() ?? Number.POSITIVE_INFINITY;
    return month < MIN_LEASE_USD ? 'month-cap' : null;
  }
}

/** A document found in the scope, by its id in the collection asked about (ADR 0028). */
const inScope = (topic: string, { topic: home, document }: ExistingDocument) =>
  home === topic
    ? document
    : { ...document, id: `${home.slice(topic.length + 1)}/${document.id}` };

/** What the view needs that takes a wait, or is read once for a whole list. */
interface KnownOfUpload {
  readonly received: number | null;
  readonly kept: boolean;
  readonly ledger: BatchLedger;
}

/** What every upload starts with. */
const NEW_RECORD = {
  failure: null,
  detail: null,
  document: null,
  mediaId: null,
  lease: null,
  attempts: 0,
  spentUsd: 0,
  dismissed: false,
  review: false,
  workMs: null,
  entries: [],
} as const;

interface UploadKey {
  readonly sha256: string | null;
  readonly url: string | null;
}

/** An upload of the same original, or of the same link. */
const isSame = (one: DocumentUploadRecord, key: UploadKey): boolean =>
  (key.sha256 !== null && one.sha256 === key.sha256) ||
  (key.url !== null && one.url !== null && sameLinkKey(one.url) === key.url);

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
    kind: linkKindOf(request),
    name: request.title ?? request.url,
    url: request.url,
    sha256: null,
    bytes: null,
    state: 'received',
  };
}

/** What a link becomes: as its sender says, or as its address tells. */
function linkKindOf(
  request: Extract<CreateDocumentUploadRequest, { kind: 'url' }>,
): 'url' | 'recording' | 'list' {
  if (request.as) return request.as === 'page' ? 'url' : 'recording';
  return recordingLinkKind(request.url) ?? 'url';
}

const keyOf = (request: CreateDocumentUploadRequest): UploadKey => ({
  sha256: request.kind === 'file' ? request.sha256 : null,
  url: request.kind === 'url' ? sameLinkKey(request.url) : null,
});

const ownerOf = (actor: UploadActor): UploadOwner => ({
  principal: actor.principal,
  email: actor.email,
  isMaster: actor.isMaster,
  quotaBytes: actor.quotaBytes ?? null,
  displayName: actor.displayName ?? null,
});
