import { randomUUID } from 'node:crypto';
import type { DocumentRemoval, DocumentRemovalState } from '@kb-chat/contracts';
import { AppError } from '../../app-error.js';
import type { RemovalRecord } from '../../ports/document-removals.js';
import { isTrackEntry, type CatalogRegistry } from '../catalog/index.js';
import { isPending } from './removal-queue.js';
import type { RemovalRecords } from './removal-records.js';

/** A master, as the removal keeps them. */
export interface RemovalActor {
  readonly email: string;
  readonly name: string;
  readonly canSee: (topic: string) => boolean;
  readonly seesDocument: (topic: string, id: string) => boolean;
}

export interface RemovalServiceDeps {
  readonly records: RemovalRecords;
  readonly catalog: CatalogRegistry;
  readonly levelOf: (topic: string, id: string) => string | null;
  /** It left the collection: what sent it there leaves the list of what is being done. */
  readonly left?: (topic: string, id: string) => Promise<void>;
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
    const record: RemovalRecord = {
      id:
        this.deps.records.of(found.topic, found.document.id)?.id ??
        randomUUID(),
      ...found,
      level: this.deps.levelOf(found.topic, found.document.id),
      by: { email: actor.email, name: actor.name },
      removedAt: this.now().toISOString(),
      wish: 'removed',
      isQuarantined: false,
      lease: null,
      attempts: 0,
      failed: false,
      detail: null,
    };
    await this.deps.records.put(record);
    await this.deps.catalog.refresh(found.topic);
    await this.deps.left?.(found.topic, found.document.id);
    return toRemoval(record);
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
    // The Mac never took it: there is nothing to move back.
    const nothingToMove = !isPending(asked) && asked.lease === null;
    if (nothingToMove) await this.deps.records.remove(id);
    await this.deps.catalog.refresh(record.topic);
    return nothingToMove ? null : toRemoval(asked);
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
    return toRemoval(again);
  }

  list(actor: RemovalActor): DocumentRemoval[] {
    return this.deps.records
      .all()
      .filter((one) => actor.canSee(one.topic))
      .sort((a, b) => b.removedAt.localeCompare(a.removedAt))
      .map(toRemoval);
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
  return record.isQuarantined ? 'removed' : 'removing';
}

const toRemoval = (record: RemovalRecord): DocumentRemoval => ({
  id: record.id,
  topic: record.topic,
  document: record.document,
  state: stateOf(record),
  detail: record.detail,
  by: record.by.name || record.by.email,
  removedAt: record.removedAt,
});
