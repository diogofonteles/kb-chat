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
  type DocumentUploadList,
  type RecordingEntryList,
  type DocumentWork,
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
import { MacLine } from './mac-line.js';
import {
  BatchLedger,
  MIN_LEASE_USD,
  WORKING_STATES,
  isWorking,
  isStalled,
} from './upload-batches.js';
import type { UploadKey, UploadRecords } from './upload-records.js';
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
  /** The Mac that publishes to the collections: paired, seen in the last minutes, or not. */
  readonly mac?: () => DocumentWork['mac'];
  /** What the media month still has (ADR 0035 §11): at zero, everything waits. */
  readonly monthLeftUsd?: () => number;
  readonly now?: () => Date;
}

/** Of what ended, the newest listed in "Documentos em processamento". */
const LIST_LIMIT = 1_000;
/** A file whose bytes stopped arriving this long ago is given up (as media, ADR 0033). */
export const DOCUMENT_UPLOAD_ABANDON_MS = 7 * 24 * 60 * 60 * 1000;
/** What ended this long ago leaves the record: the collection itself answers for it. */
export const DOCUMENT_UPLOAD_KEEP_MS = 90 * 24 * 60 * 60 * 1000;

const ENDED = new Set<DocumentUploadRecord['state']>(['mapped', 'failed']);
const NO_MAC: DocumentWork['mac'] = {
  state: 'none',
  lastSeenAt: null,
  doing: null,
};
/** Its recording is not in the library any more. */
const GONE: MediaProgress = { state: 'failed', step: null };

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
    const free =
      request.kind === 'file' ? await this.deps.files.freeBytes() : 0;
    // From here to the record there is no wait: what several announce at once adds up.
    const meanwhile = this.repeated(actor, topic, key);
    if (meanwhile) return meanwhile;
    if (request.kind === 'file') this.assertRoom(actor, request.bytes, free);
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
      .sameAs(key)
      .find(
        (one) =>
          one.state === 'receiving' &&
          one.topic === topic &&
          one.owner.principal === actor.principal,
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
  private assertRoom(actor: UploadActor, bytes: number, free: number): void {
    const all = this.deps.records.all();
    const waiting = all
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
    // Announced and not arrived yet: the disk does not show it, and it will come.
    const coming = all
      .filter((one) => one.state === 'receiving')
      .reduce((sum, one) => sum + (one.bytes ?? 0), 0);
    if (free - coming - bytes < DOCUMENT_DISK_RESERVE_BYTES)
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
      .sameAs(key)
      .find((one) => scope.includes(one.topic) && this.isLive(one));
    if (!pending) return null;
    const mine = pending.owner.principal === actor.principal || actor.isMaster;
    const upload = mine
      ? this.viewNow(pending, actor, {
          received: null,
          kept: false,
          moment: this.moment(),
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
    // Taken off the list before it entered: it was cancelled.
    if (record.dismissed && !ENTERED.has(record.state)) return false;
    if (!record.mediaId || !this.deps.mediaProgressOf) return true;
    return this.mediaOf(record)?.state !== 'failed';
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
    if (
      record.spentUsd > 0 ||
      record.state === 'mapped' ||
      record.mediaId !== null
    )
      await this.deps.records.update(id, (one) => ({
        ...one,
        dismissed: true,
        // A Mac that lost it and wakes later must not bring it in.
        lease: null,
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
    const fresh = urls.filter(
      (url) =>
        !this.repeated(actor, list.topic, {
          sha256: null,
          url: sameLinkKey(url),
        }),
    );
    // One change: a second press finds nothing to choose from, and a crash loses nothing.
    const titles = new Map(list.entries.map((one) => [one.url, one.title]));
    await this.deps.records.replace(
      id,
      fresh.map((url) => this.chosenOf(list, url, titles.get(url) ?? url)),
    );
    return { created: fresh.length, already: urls.length - fresh.length };
  }

  /** What a list holds, for who may choose from it. */
  entriesOf(actor: UploadActor, id: string): RecordingEntryList {
    const list = this.deps.records.get(id);
    if (!list || !this.mayManage(actor, list)) throw notFound();
    if (list.state !== 'choosing') throw notWaiting();
    return { entries: [...list.entries] };
  }

  private chosenOf(
    list: DocumentUploadRecord,
    url: string,
    name: string,
  ): DocumentUploadRecord {
    const at = this.now().toISOString();
    return {
      ...list,
      id: randomUUID(),
      kind: 'recording',
      name,
      url,
      state: 'received',
      failure: null,
      detail: null,
      lease: null,
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
    if (!this.hasFailed(record) || !(await this.isKept(record)))
      throw notWaiting();
    const again = await this.deps.records.update(id, (current) => ({
      ...current,
      kind: kindAgainOf(current),
      refused: null,
      ...this.fromTheStart(),
    }));
    if (!again) throw notFound();
    return this.viewOf(again, actor);
  }

  /**
   * What kb refused enters all the same (KBC-009): only a master says so, having read what was
   * read; the Mac takes it out of kb's quarantine and the usual steps follow.
   */
  async accept(actor: UploadActor, id: string): Promise<DocumentUpload> {
    const record = this.deps.records.get(id);
    if (!record || !this.mayManage(actor, record)) throw notFound();
    if (!actor.isMaster)
      throw new AppError('FORBIDDEN', 'Only a master accepts what kb refused');
    if (record.state !== 'failed' || !record.refused) throw notWaiting();
    // Two people may have sent it, each refused: accepted twice it would be there twice.
    const key = keyOfRecord(record);
    if (this.repeated(actor, record.topic, key))
      throw new AppError('DOCUMENT_DUPLICATE', 'It is there, or on its way');
    const accepted = await this.deps.records.update(id, (current) => ({
      ...current,
      refused: current.refused && { ...current.refused, accepted: true },
      ...this.fromTheStart(),
    }));
    if (!accepted) throw notFound();
    return this.viewOf(accepted, actor);
  }

  /**
   * The Mac went silent in the middle of it (KBC-184): it waits for a Mac again now, without
   * waiting for the lease to run out. A Mac that was only away finds it is no longer its own.
   */
  async resumeStalled(actor: UploadActor, id: string): Promise<DocumentUpload> {
    const record = this.deps.records.get(id);
    if (!record || !this.mayManage(actor, record)) throw notFound();
    if (!isStalled(record, this.now())) throw notWaiting();
    const resumed = await this.deps.records.update(id, (current) => ({
      ...current,
      state: 'received',
      lease: null,
      updatedAt: this.now().toISOString(),
    }));
    if (!resumed) throw notFound();
    return this.viewOf(resumed, actor);
  }

  private fromTheStart() {
    return {
      state: 'received',
      failure: null,
      detail: null,
      mediaId: null,
      attempts: 0,
      updatedAt: this.now().toISOString(),
    } as const;
  }

  /** Its own end, or its recording's: failed, or deleted from the library. */
  private hasFailed(record: DocumentUploadRecord): boolean {
    if (record.state === 'failed') return true;
    if (record.state !== 'transcribing') return false;
    const media = this.mediaOf(record);
    return media !== null && media.state === 'failed';
  }

  private mediaOf(record: DocumentUploadRecord): MediaProgress | null {
    const { mediaProgressOf } = this.deps;
    if (!record.mediaId || !mediaProgressOf) return null;
    return mediaProgressOf(record.mediaId) ?? GONE;
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
  async list(actor: UploadActor): Promise<DocumentUploadList> {
    const all = this.visibleTo(actor).sort((a, b) =>
      b.createdAt.localeCompare(a.createdAt),
    );
    // What has not ended is always there; of what ended, the newest.
    let ended = 0;
    const records = all.filter(
      (one) => !ENDED.has(one.state) || ++ended <= LIST_LIMIT,
    );
    const moment = this.moment();
    const items = await Promise.all(
      records.map((one) => this.viewOf(one, actor, moment)),
    );
    const { busy, waiting } = moment.line;
    return { items, work: { mac: moment.mac, busy, waiting } };
  }

  private visibleTo(actor: UploadActor): DocumentUploadRecord[] {
    return this.deps.records
      .all()
      .filter(
        (one) =>
          !one.dismissed &&
          (actor.isMaster || one.owner.principal === actor.principal) &&
          actor.canSee(one.topic),
      );
  }

  /** What is ready leaves the list; it stays in the collection, and in its inclusion's account. */
  async clearReady(
    actor: UploadActor,
    ids: readonly string[],
  ): Promise<number> {
    const moment = this.moment();
    const asked = new Set(ids);
    // Only what the person saw ready, and sent: another one's is for them to see.
    const ready = this.visibleTo(actor).filter(
      (one) =>
        asked.has(one.id) &&
        one.owner.principal === actor.principal &&
        this.viewNow(one, actor, { received: null, kept: false, moment })
          .state === 'ready',
    );
    await this.deps.records.put(
      ...ready.map((one) => ({ ...one, dismissed: true })),
    );
    return ready.length;
  }

  /** Everything a view is told of besides its own item, read once for a whole list. */
  private moment(): Moment {
    const now = this.now();
    const records = this.deps.records.all();
    const ledger = new BatchLedger(records, now);
    const mac = this.deps.mac?.() ?? NO_MAC;
    const line = new MacLine(records, {
      now,
      costs: contentCostsOf(records),
      mac,
      isWaiting: (one) =>
        waitsForMac(one, now) && this.heldBy(one, ledger) === null,
    });
    return { now, ledger, line, mac };
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
      (one) => since(one) > DOCUMENT_UPLOAD_KEEP_MS && this.isForgettable(one),
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

  /** The collection answers for a document; for a recording, only while it is not there. */
  private isForgettable(record: DocumentUploadRecord): boolean {
    if (ENDED.has(record.state) || record.dismissed)
      return record.mediaId === null || this.hasFailed(record);
    return this.hasFailed(record);
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
    moment = this.moment(),
  ): Promise<DocumentUpload> {
    const received =
      record.kind === 'file'
        ? record.state === 'receiving'
          ? await this.deps.files.offset(record.id)
          : record.bytes
        : null;
    const kept = this.hasFailed(record) && (await this.isKept(record));
    return this.viewNow(record, actor, { received, kept, moment });
  }

  private viewNow(
    record: DocumentUploadRecord,
    actor: UploadActor,
    known: KnownOfUpload,
  ): DocumentUpload {
    const media = this.mediaOf(record);
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
    const { ledger, line, now } = known.moment;
    return {
      isMaster: actor.isMaster,
      received: known.received,
      kept: known.kept,
      batch: record.batch ? ledger.viewOf(record.batch.id) : null,
      heldBy: this.heldBy(record, ledger),
      place: line.placeOf(record.id),
      now,
      mine: record.owner.principal === actor.principal,
      seesLevel: seesLevel(actor, record),
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

function seesLevel(
  actor: UploadActor,
  { topic, level }: Pick<DocumentUploadRecord, 'topic' | 'level'>,
): boolean {
  const allowed = actor.levelsIn(topic);
  return level === null || allowed === null || allowed.includes(level);
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
  readonly moment: Moment;
}

/** The inclusions' account, the Mac and its line, at one moment. */
interface Moment {
  readonly now: Date;
  readonly ledger: BatchLedger;
  readonly line: MacLine;
  readonly mac: DocumentWork['mac'];
}

/** Received, or dropped by a Mac that stopped answering: the Mac may take it. */
const waitsForMac = (record: DocumentUploadRecord, now: Date): boolean =>
  !record.dismissed &&
  (record.state === 'received' ||
    (WORKING_STATES.has(record.state) && !isWorking(record, now)));

/** In the collection, or on its way to it through the library. */
const ENTERED = new Set<DocumentUploadRecord['state']>([
  'mapped',
  'transcribing',
]);

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
  refused: null,
  entries: [],
} as const;

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
/** A page kb refused, at an address that is a recording's: its sound is what there is of it. */
const kindAgainOf = ({
  kind,
  url,
  failure,
}: DocumentUploadRecord): DocumentUploadRecord['kind'] =>
  kind === 'url' &&
  failure === 'not-accepted' &&
  url !== null &&
  recordingLinkKind(url) === 'recording'
    ? 'recording'
    : kind;

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

const keyOfRecord = ({ sha256, url }: DocumentUploadRecord): UploadKey => ({
  sha256,
  url: url === null ? null : sameLinkKey(url),
});

const ownerOf = (actor: UploadActor): UploadOwner => ({
  principal: actor.principal,
  email: actor.email,
  isMaster: actor.isMaster,
  quotaBytes: actor.quotaBytes ?? null,
  displayName: actor.displayName ?? null,
});
