import { randomUUID } from 'node:crypto';
import type { DocumentRemoval, DocumentRemovalState } from '@kb-chat/contracts';
import { AppError } from '../../app-error.js';
import type { RemovalRecord } from '../../ports/document-removals.js';
import { isTrackEntry, type CatalogRegistry } from '../catalog/index.js';
import { isPending } from './removal-queue.js';
import type { RemovalRecords } from './removal-records.js';

/** A master, as the removal keeps them. */
export interface RemovalActor {
  readonly principal: string;
  readonly email: string;
  readonly name: string;
  readonly canSee: (topic: string) => boolean;
  readonly seesDocument: (topic: string, id: string) => boolean;
}

export interface RemovalServiceDeps {
  readonly records: RemovalRecords;
  readonly catalog: CatalogRegistry;
  readonly levelOf: (topic: string, id: string) => string | null;
  /** Who asked for what: the record itself ends when it is back. */
  readonly done?: (
    what: 'remove' | 'restore' | 'retry',
    record: RemovalRecord,
    by: string,
  ) => void;
  /** Back, it has the level it had (ADR 0036 §5). */
  readonly placeLevel?: (record: RemovalRecord) => Promise<void>;
  readonly now?: () => Date;
}

const gone = () =>
  new AppError('DOCUMENT_NOT_FOUND', 'No such document in this collection');
const notFound = () => new AppError('NOT_FOUND', 'No such removal');
const notWaiting = () =>
  new AppError('MEDIA_CONFLICT', 'This removal is not waiting for this');

/** What kb keeps in `raw/`: its own pages (concepts) come from them and are not removed. */
const isSource = (id: string): boolean => id.startsWith('raw/');

/**
 * Taking a document out of its collection, and back (KBC-187): masters. It is hidden at once
 * (the collection is read again without it); the Mac then moves the file to kb's quarantine,
 * which keeps its references. Nothing is deleted.
 */
export class RemovalService {
  private readonly now: () => Date;

  constructor(private readonly deps: RemovalServiceDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  async remove(
    actor: RemovalActor,
    topic: string,
    documentId: string,
  ): Promise<DocumentRemoval> {
    const found = this.find(actor, topic, documentId);
    const { topic: home, document } = found;
    // Asked back before and not there yet: the Mac may be at it.
    const before = this.deps.records.of(home, document.id);
    const record: RemovalRecord = {
      id: before?.id ?? randomUUID(),
      ...found,
      level: this.deps.levelOf(home, document.id) ?? before?.level ?? null,
      by: { email: actor.email, name: actor.name },
      removedAt: this.now().toISOString(),
      wish: 'removed',
      isQuarantined: before ? before.isQuarantined : false,
      lease: before?.lease ?? null,
      attempts: 0,
      failed: false,
      detail: null,
    };
    await this.deps.records.put(record);
    this.deps.catalog.hide(home);
    this.deps.done?.('remove', record, actor.principal);
    return this.toRemoval(record);
  }

  /** A text of the collection or of a sub-collection, by its id in the one asked about. */
  private find(
    actor: RemovalActor,
    topic: string,
    documentId: string,
  ): Pick<RemovalRecord, 'topic' | 'document'> {
    if (!actor.canSee(topic)) throw gone();
    const entry = this.deps.catalog.scopeView(topic)?.entries.get(documentId);
    const home = entry?.home ?? { topic, id: documentId };
    const isRemovable =
      entry !== undefined &&
      isSource(home.id) &&
      // A recording's track leaves with its recording, in the library (BR-7).
      !isTrackEntry(entry) &&
      actor.seesDocument(home.topic, home.id);
    if (!isRemovable) throw gone();
    return {
      topic: home.topic,
      document: { id: home.id, title: entry.title },
    };
  }

  async restore(
    actor: RemovalActor,
    id: string,
  ): Promise<DocumentRemoval | null> {
    const record = this.visible(actor, id);
    if (record.wish !== 'removed') throw notWaiting();
    const asked = await this.deps.records.update(id, (current) => ({
      ...current,
      wish: 'present',
      attempts: 0,
      failed: false,
      detail: null,
    }));
    if (!asked) throw notFound();
    this.deps.done?.('restore', asked, actor.principal);
    // No Mac was ever asked to take it: there is nothing to move back.
    const nothingToMove = !isPending(asked) && asked.lease === null;
    if (nothingToMove) {
      await this.deps.placeLevel?.(asked);
      await this.deps.records.remove(id);
    }
    await this.deps.catalog.refresh(record.topic);
    return nothingToMove ? null : this.toRemoval(asked);
  }

  /** The Mac gave up on it: asked again as it was. */
  async retry(actor: RemovalActor, id: string): Promise<DocumentRemoval> {
    if (!this.visible(actor, id).failed) throw notWaiting();
    const again = await this.deps.records.update(id, (current) => ({
      ...current,
      attempts: 0,
      failed: false,
      detail: null,
    }));
    if (!again) throw notFound();
    this.deps.done?.('retry', again, actor.principal);
    return this.toRemoval(again);
  }

  list(actor: RemovalActor): DocumentRemoval[] {
    return this.deps.records
      .all()
      .filter((one) => actor.canSee(one.topic))
      .sort((a, b) => b.removedAt.localeCompare(a.removedAt))
      .map((one) => this.toRemoval(one));
  }

  private toRemoval(record: RemovalRecord): DocumentRemoval {
    const { id, topic, document, detail, by, removedAt } = record;
    return {
      ...{ id, topic, document, detail, removedAt },
      collection: this.deps.catalog.get(topic)?.topic.title ?? topic,
      state: stateOf(record),
      asked: record.wish,
      by: by.name || by.email,
    };
  }

  private visible(actor: RemovalActor, id: string): RemovalRecord {
    const record = this.deps.records.get(id);
    if (!record || !actor.canSee(record.topic)) throw notFound();
    return record;
  }
}

function stateOf(record: RemovalRecord): DocumentRemovalState {
  if (record.failed) return 'failed';
  if (record.wish === 'present') return 'restoring';
  return record.isQuarantined === true ? 'removed' : 'removing';
}
