import type {
  BulkLevelRequest,
  BulkLevelResult,
  ContentLevel,
  LevelAuditEntry,
  LevelChoice,
  UnassignedCounts,
  UnassignedPage,
  UnassignedQuery,
} from '@kb-chat/contracts';
import { unassignedQuerySchema } from '@kb-chat/contracts';
import { AppError } from '../../app-error.js';
import type { LevelAuditPort } from '../../ports/level-audit.js';
import {
  canSeeTopic,
  isMaster,
  type ParentOf,
  type StoredPerson,
} from '../auth/index.js';
import {
  isTrackEntry,
  type CatalogEntry,
  type CatalogRegistry,
} from '../catalog/index.js';
import type { LevelActor } from './access-levels-service.js';
import type { ContentGate } from './content-gate.js';
import type {
  CollectionPlacements,
  DocumentPresence,
  LevelDirectory,
  PresenceMap,
  StoredLevel,
} from './level-directory.js';
import {
  byArrival,
  cursorOf,
  facetsOf,
  matches,
  offsetOf,
  toRow,
  type UnassignedRow,
} from './unassigned.js';

/** How long a level outlives its document's absence from the vault (BR-5). */
export const MISSING_KEEP_MS = 30 * 24 * 60 * 60 * 1000;

export interface DocumentLevelsDeps {
  readonly directory: LevelDirectory;
  readonly catalog: CatalogRegistry;
  readonly gate: ContentGate;
  readonly audit: LevelAuditPort;
  readonly parentOf: ParentOf;
  /** Told when a reconcile after a catalog load fails (it is retried on the next load). */
  readonly onError?: (err: unknown) => void;
}

/** Who asks: the audit's names and the person whose level and view apply. */
export interface Classifier {
  readonly actor: LevelActor;
  readonly person: StoredPerson;
}

/** One document of the scope, in its own collection. */
interface Target {
  readonly topic: string;
  readonly entry: CatalogEntry;
}

const notFound = () =>
  new AppError('DOCUMENT_NOT_FOUND', 'Document not found');
const unknownLevel = () =>
  new AppError('VALIDATION_FAILED', 'Unknown level', {
    details: { field: 'level' },
  });

const keyOf = (key: { readonly topic: string; readonly id: string }) =>
  `${key.topic}\n${key.id}`;

const choiceOf = ({ id, code }: StoredLevel): LevelChoice => ({ id, code });

/**
 * Documents' levels (KBC-103 FR-4, KBC-107, ADR 0036 §3, §5, §9, §11): the "Sem nível"
 * queue, single and bulk levels up to the caller's own, and the presence the catalog's loads
 * keep. Writes and reconciles run one after the other; each write is audited before it answers.
 */
export class DocumentLevelsService {
  private writing: Promise<unknown> = Promise.resolve();

  constructor(private readonly deps: DocumentLevelsDeps) {}

  /** GET …/levels/unassigned (FR-1): one page of the queue the caller may classify. */
  async unassigned(
    person: StoredPerson,
    topic: string,
    query: UnassignedQuery,
  ): Promise<UnassignedPage> {
    await this.settled();
    const { cursor, limit, ...filter } = unassignedQuerySchema.parse(query);
    const root = this.deps.gate.rootOf(topic);
    const asOf = new Date().toISOString();
    const rows = this.queue(person, root);
    const kept = rows.filter(matches(filter)).sort(byArrival);
    const offset = offsetOf(cursor);
    const next = offset + limit;
    return {
      collection: root,
      total: rows.length,
      matched: kept.length,
      asOf,
      items: kept.slice(offset, next),
      nextCursor: next < kept.length ? cursorOf(next) : null,
      facets: facetsOf(rows),
      levels: this.choicesOf(person, root),
    };
  }

  /** GET …/levels/choices: the levels the caller may give in this collection. */
  choices(
    person: StoredPerson,
    topic: string,
  ): { collection: string; levels: LevelChoice[] } {
    const root = this.deps.gate.rootOf(topic);
    return { collection: root, levels: this.choicesOf(person, root) };
  }

  /** GET /levels/unassigned: the queue's size per scaled collection the person sees. */
  async counts(person: StoredPerson): Promise<UnassignedCounts> {
    await this.settled();
    const items = this.scaledRoots()
      .filter((root) => this.visibleScope(person, root).length > 0)
      .map((collection) => ({
        collection,
        unassigned: this.queue(person, collection).length,
      }))
      .sort((a, b) => a.collection.localeCompare(b.collection));
    return { items };
  }

  /** FR-4, BR-2: one document's level, up to the caller's own. */
  setOne(
    who: Classifier,
    target: { readonly topic: string; readonly id: string; level: string },
  ): Promise<{ level: ContentLevel }> {
    return this.serial(async () => {
      const found = this.targetOf(who.person, target);
      if (!found) throw notFound();
      const chosen = this.levelFor(who.person, target.topic, target.level);
      await this.write(who.actor, { level: chosen, targets: [found] });
      return { level: choiceOf(chosen) };
    });
  }

  /** FR-2, BR-2, BR-3: a level for a selection or for the queue a filter keeps. */
  bulk(
    who: Classifier,
    topic: string,
    request: BulkLevelRequest,
  ): Promise<BulkLevelResult> {
    return this.serial(async () => {
      const root = this.deps.gate.rootOf(topic);
      const chosen = this.levelFor(who.person, root, request.level);
      const { targets, skipped, filter } = this.bulkTargets(
        who.person,
        root,
        request,
      );
      await this.write(who.actor, {
        level: chosen,
        targets,
        bulk: { root, filter, skipped },
      });
      return { level: choiceOf(chosen), updated: targets.length, skipped };
    });
  }

  /**
   * FR-5, BR-5, after each catalog load: a document without a level gets its first sighting;
   * a placed one gone from the vault starts its 30 days and, past them, loses its level.
   */
  reconcile(): Promise<void> {
    return this.serial(async () => {
      const now = Date.now();
      const presence = clonePresence(this.deps.directory.presenceMap());
      const gone = this.expire(presence, now);
      if (Object.keys(gone).length > 0) await this.deps.directory.forget(gone);
      this.markArrivals(presence, new Date(now).toISOString());
      const before = JSON.stringify(this.deps.directory.presenceMap());
      if (JSON.stringify(presence) !== before)
        await this.deps.directory.setPresence(presence);
    }).catch((err: unknown) => this.deps.onError?.(err));
  }

  private bulkTargets(
    person: StoredPerson,
    root: string,
    request: BulkLevelRequest,
  ): { targets: Target[]; skipped: number; filter: unknown } {
    if ('filter' in request) {
      const rows = this.queue(person, root).filter(matches(request.filter));
      const targets = rows.flatMap((row) => this.targetOf(person, row) ?? []);
      return { targets, skipped: 0, filter: request.filter };
    }
    const named = new Map(request.ids.map((key) => [keyOf(key), key]));
    const targets = [...named.values()].flatMap(
      (key) =>
        (this.inScope(root, key.topic) && this.targetOf(person, key)) || [],
    );
    return {
      targets,
      skipped: named.size - targets.length,
      filter: { ids: request.ids.length },
    };
  }

  /** One write of `document-levels.json` and one of the audit (NFR-1, BR-4). */
  private async write(actor: LevelActor, change: LevelChange): Promise<void> {
    const at = new Date().toISOString();
    const placed = { level: change.level.id, setBy: actor.by, setAt: at };
    const byCollection: Record<string, Record<string, typeof placed>> = {};
    for (const { topic, entry } of change.targets)
      (byCollection[topic] ??= {})[entry.id] = placed;
    const lines = auditLines(
      { at, by: actor.by, ...(actor.actingAs && { actingAs: actor.actingAs }) },
      change,
      (topic, id) => this.deps.directory.placementsOf(topic)[id]?.level ?? null,
    );
    if (change.targets.length > 0)
      await this.deps.directory.place(byCollection);
    await this.deps.audit.appendMany(lines);
  }

  /** The level asked for, if it exists and is at or below the caller's (403 above). */
  private levelFor(
    person: StoredPerson,
    topic: string,
    level: string,
  ): StoredLevel {
    const scale = this.deps.gate.scaleOf(topic);
    const at = scale.findIndex((one) => one.id === level);
    const chosen = scale[at];
    if (!chosen) throw unknownLevel();
    if (!isMaster(person) && at > this.deps.gate.personRank(person, topic))
      throw new AppError('FORBIDDEN', 'That level is above yours');
    return chosen;
  }

  /** A text of a collection the person sees, in their view (unknown, hidden: undefined). */
  private targetOf(
    person: StoredPerson,
    key: { readonly topic: string; readonly id: string },
  ): Target | undefined {
    const entry = this.deps.catalog.get(key.topic)?.entries.get(key.id);
    if (!entry || isTrackEntry(entry)) return undefined;
    if (!canSeeTopic(person, key.topic, this.deps.parentOf)) return undefined;
    const view = this.deps.gate.viewFor(person, key.topic);
    return view.allows(key.topic, entry) ? { topic: key.topic, entry } : undefined;
  }

  private inScope(root: string, topic: string): boolean {
    return (
      this.deps.catalog.get(topic) !== undefined &&
      this.deps.gate.rootOf(topic) === root
    );
  }

  private choicesOf(person: StoredPerson, root: string): LevelChoice[] {
    const scale = this.deps.directory.scaleOf(root);
    const top = isMaster(person)
      ? scale.length
      : this.deps.gate.personRank(person, root) + 1;
    return scale.slice(0, top).map(choiceOf);
  }

  /** The collections of a scope the person sees. */
  private visibleScope(person: StoredPerson, root: string) {
    return this.deps.catalog
      .scope(root)
      .filter((one) => canSeeTopic(person, one.topic.slug, this.deps.parentOf));
  }

  /** Every text without a level of the scope, in the collections the person sees (BR-1). */
  private queue(person: StoredPerson, root: string): UnassignedRow[] {
    const scale = this.deps.directory.scaleOf(root);
    if (scale.length === 0) return [];
    const presence = this.deps.directory.presenceMap();
    return this.visibleScope(person, root).flatMap((catalog) => {
      const slug = catalog.topic.slug;
      const placed = this.deps.directory.placementsOf(slug);
      return unplacedTexts(catalog.entries.values(), { placed, scale }).map(
        (entry) =>
          toRow(slug, entry, firstSeen(presence[slug]?.[entry.id], placed[entry.id]?.setAt)),
      );
    });
  }

  private scaledRoots(): string[] {
    return this.deps.catalog
      .topics()
      .map((one) => one.topic.slug)
      .filter(
        (slug) =>
          this.deps.gate.rootOf(slug) === slug &&
          this.deps.directory.scaleOf(slug).length > 0,
      );
  }

  /** Placed documents gone too long lose their level; the others start or stop the clock. */
  private expire(
    presence: Record<string, Record<string, DocumentPresence>>,
    now: number,
  ): Record<string, string[]> {
    const gone: Record<string, string[]> = {};
    for (const collection of this.deps.directory.placedCollections()) {
      const entries = this.deps.catalog.get(collection)?.entries;
      const ids = Object.keys(this.deps.directory.placementsOf(collection));
      const marks = (presence[collection] ??= {});
      const verdicts = ids.map((id) => {
        const present = entries?.has(id) === true;
        return [id, absence(marks[id], { present, now })] as const;
      });
      const expired = verdicts.filter(([, mark]) => mark === 'expired');
      if (expired.length > 0) gone[collection] = expired.map(([id]) => id);
      for (const [id, mark] of verdicts)
        marks[id] = mark === 'expired' ? {} : mark;
    }
    return gone;
  }

  /** Each text without a level in a scaled collection gets the moment it was first seen. */
  private markArrivals(
    presence: Record<string, Record<string, DocumentPresence>>,
    now: string,
  ): void {
    for (const root of this.scaledRoots()) {
      const scale = this.deps.directory.scaleOf(root);
      for (const catalog of this.deps.catalog.scope(root)) {
        const slug = catalog.topic.slug;
        const placed = this.deps.directory.placementsOf(slug);
        const texts = unplacedTexts(catalog.entries.values(), { placed, scale });
        presence[slug] = arrivals(presence[slug] ?? {}, { texts, now });
      }
    }
    prune(presence, (collection, id) => {
      const entries = this.deps.catalog.get(collection)?.entries;
      const placed = this.deps.directory.placementsOf(collection)[id];
      return placed !== undefined || entries?.has(id) === true;
    });
  }

  private settled(): Promise<void> {
    return this.writing.then(() => undefined);
  }

  private serial<T>(run: () => Promise<T>): Promise<T> {
    const next = this.writing.then(run);
    this.writing = next.catch(() => undefined);
    return next;
  }
}

/** What one write sets: a level on documents, and for a bulk its line (BR-4). */
interface LevelChange {
  readonly level: StoredLevel;
  readonly targets: readonly Target[];
  readonly bulk?: {
    readonly root: string;
    readonly filter: unknown;
    readonly skipped: number;
  };
}

type AuditBase = Pick<LevelAuditEntry, 'at' | 'by' | 'actingAs'>;

/** The bulk's line (when it is one) and one line per document, before → after. */
function auditLines(
  base: AuditBase,
  change: LevelChange,
  levelBefore: (topic: string, id: string) => string | null,
): LevelAuditEntry[] {
  const { level, targets, bulk } = change;
  const items = targets.map(
    ({ topic, entry }): LevelAuditEntry => ({
      ...base,
      kind: 'item.level',
      collection: topic,
      target: entry.id,
      before: levelBefore(topic, entry.id),
      after: level.id,
    }),
  );
  if (!bulk) return items;
  const count = { documents: targets.length, people: 0, skipped: bulk.skipped };
  return [
    {
      ...base,
      kind: 'bulk',
      collection: bulk.root,
      after: level.id,
      count,
      filter: bulk.filter,
    },
    ...items,
  ];
}

/** The texts with no level of the scale (none, or one deleted since). */
function unplacedTexts(
  entries: Iterable<CatalogEntry>,
  { placed, scale }: { placed: CollectionPlacements; scale: readonly StoredLevel[] },
): CatalogEntry[] {
  return [...entries].filter((entry) => {
    if (isTrackEntry(entry)) return false;
    const level = placed[entry.id]?.level;
    return !scale.some((one) => one.id === level);
  });
}

/** The marks of a collection with a first sighting for each text that had none. */
function arrivals(
  marks: Record<string, DocumentPresence>,
  { texts, now }: { texts: readonly CatalogEntry[]; now: string },
): Record<string, DocumentPresence> {
  const next = { ...marks };
  for (const { id } of texts)
    next[id] = { ...next[id], firstSeenAt: next[id]?.firstSeenAt ?? now };
  return next;
}

const firstSeen = (
  mark: DocumentPresence | undefined,
  setAt: string | undefined,
): string => mark?.firstSeenAt ?? setAt ?? new Date(0).toISOString();

/** A placed document's next mark, or `expired` once it has been gone 30 days (BR-5). */
function absence(
  mark: DocumentPresence | undefined,
  { present, now }: { present: boolean; now: number },
): DocumentPresence | 'expired' {
  const since = mark?.missingSince;
  if (since !== undefined && now - Date.parse(since) > MISSING_KEEP_MS)
    return 'expired';
  if (present) return {};
  return { missingSince: since ?? new Date(now).toISOString() };
}

const clonePresence = (
  map: PresenceMap,
): Record<string, Record<string, DocumentPresence>> =>
  Object.fromEntries(
    Object.entries(map).map(([collection, marks]) => [collection, { ...marks }]),
  );

/** Drops empty marks and those `keep` refuses; then empty collections. */
function prune(
  presence: Record<string, Record<string, DocumentPresence>>,
  keep: (collection: string, id: string) => boolean,
): void {
  for (const [collection, marks] of Object.entries(presence)) {
    const kept = Object.entries(marks).filter(
      ([id, mark]) => Object.keys(mark).length > 0 && keep(collection, id),
    );
    if (kept.length === 0) delete presence[collection];
    else presence[collection] = Object.fromEntries(kept);
  }
}
