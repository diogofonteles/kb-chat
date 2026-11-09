import {
  LEVELS_PER_SCALE_MAX,
  foldLevelCode,
  levelCreateSchema,
  levelIdOf,
  levelIdSchema,
  type ContentLevel,
  type LevelAuditEntry,
  type LevelCreate,
  type LevelRename,
  type LevelScales,
  type TopicLevels,
} from '@kb-chat/contracts';
import { AppError } from '../../app-error.js';
import type { LevelAuditPort } from '../../ports/level-audit.js';
import {
  canSeeTopic,
  isMaster,
  type ParentOf,
  type PersonLevelRules,
  type StoredPerson,
} from '../auth/index.js';
import {
  isTrackEntry,
  type CatalogEntry,
  type CatalogRegistry,
} from '../catalog/index.js';
import type { ContentGate } from './content-gate.js';
import type {
  CollectionPlacements,
  LevelDirectory,
  StoredLevel,
} from './level-directory.js';

/** Who changes levels: the master (and the person they act as, for the record). */
export interface LevelActor {
  readonly by: string;
  readonly actingAs?: string;
}

export interface AccessLevelsServiceDeps {
  readonly directory: LevelDirectory;
  readonly catalog: CatalogRegistry;
  readonly gate: ContentGate;
  readonly people: {
    list(): Promise<readonly StoredPerson[]>;
    placeLevels(placement: {
      readonly ids: readonly string[];
      readonly root: string;
      readonly level: string;
    }): Promise<number>;
  };
  readonly audit: LevelAuditPort;
  readonly parentOf: ParentOf;
  readonly now?: () => Date;
}

/** A document of a collection, as a level is set on it. */
export interface DocumentTarget {
  readonly topic: string;
  readonly id: string;
  readonly level: string;
}

const subCollection = () =>
  new AppError('VALIDATION_FAILED', 'A sub-collection uses its parent levels');
const unknownLevel = () => new AppError('NOT_FOUND', 'Unknown level');
const codeTaken = (code: string) =>
  new AppError('LEVEL_CODE_TAKEN', 'A level with that code exists', {
    details: { code },
  });

/** Texts of a collection: track documents take their level from media.db (KBC-106). */
const textsOf = (entries: Iterable<CatalogEntry>): CatalogEntry[] =>
  [...entries].filter((entry) => !isTrackEntry(entry));

/** An id no other level has: the code's, with -2, -3… when a renamed level kept it. */
function freeId(code: string, scale: readonly StoredLevel[]): string {
  const base = levelIdOf(code);
  const taken = new Set(scale.map((one) => one.id));
  let id = base;
  for (let n = 2; taken.has(id); n += 1) id = `${base}-${n}`;
  // QA-3: never an id the file could not hold (a code of symbols, "++++++++++++").
  if (!levelIdSchema.safeParse(id).success)
    throw new AppError('VALIDATION_FAILED', 'The code needs a letter', {
      details: { field: 'code' },
    });
  return id;
}

function assertFreeCode(
  scale: readonly StoredLevel[],
  code: string,
  except?: string,
): void {
  const folded = foldLevelCode(code);
  const clash = scale.find(
    (one) => one.id !== except && foldLevelCode(one.code) === folded,
  );
  if (clash) throw codeTaken(clash.code);
}

/**
 * The scales, people's levels and documents' levels (KBC-103, ADR 0036 §1–§4, §9–§11). Writes
 * run one after the other, and each is audited before it answers.
 */
export class AccessLevelsService implements PersonLevelRules {
  private writing: Promise<unknown> = Promise.resolve();

  constructor(private readonly deps: AccessLevelsServiceDeps) {}

  /** GET …/levels: the scale with its counts (T24). */
  async levelsOf(topic: string): Promise<TopicLevels> {
    if (!this.deps.catalog.get(topic))
      throw new AppError('TOPIC_NOT_FOUND', 'Unknown topic');
    const root = this.deps.gate.rootOf(topic);
    const scale = this.deps.directory.scaleOf(root);
    const docs = this.documentRanks(root, scale);
    const people = await this.peopleRanks(root);
    return {
      collection: root,
      inherited: root !== topic,
      levels: scale.map((level, rank) => ({
        id: level.id,
        code: level.code,
        description: level.description,
        documents: docs.filter((one) => one === rank).length,
        people: people.filter((one) => one === rank).length,
      })),
      documents: docs.length,
      people: people.length,
      unassigned: scale.length === 0 ? 0 : docs.filter((one) => one < 0).length,
    };
  }

  /** GET /levels: each top-level collection with a scale, its levels as choices. */
  scales(): LevelScales {
    const items = this.deps.catalog
      .topics()
      .map((catalog) => catalog.topic.slug)
      .filter((slug) => this.deps.gate.rootOf(slug) === slug)
      .map((collection) => ({
        collection,
        levels: this.deps.directory
          .scaleOf(collection)
          .map(({ id, code }) => ({ id, code })),
      }))
      .filter((one) => one.levels.length > 0)
      .sort((a, b) => a.collection.localeCompare(b.collection));
    return { items };
  }

  /** A new level, at the top; the first one places everything at it (BR-4). */
  create(
    actor: LevelActor,
    topic: string,
    input: LevelCreate,
  ): Promise<TopicLevels> {
    const { code, description } = levelCreateSchema.parse(input);
    return this.serial(async () => {
      const root = this.requireRoot(topic);
      const scale = this.deps.directory.scaleOf(root);
      const level = this.newLevel(actor, { scale, code, description });
      if (scale.length === 0) await this.seed(actor, { root, level: level.id });
      await this.deps.directory.changeScale(root, (current) => ({
        next: [...current, level],
        result: undefined,
      }));
      await this.record(actor, {
        kind: 'scale.create',
        collection: root,
        target: level.id,
        after: { code, description },
      });
      return this.levelsOf(root);
    });
  }

  private newLevel(
    actor: LevelActor,
    input: {
      readonly scale: readonly StoredLevel[];
      readonly code: string;
      readonly description: string;
    },
  ): StoredLevel {
    const { scale, code, description } = input;
    if (scale.length >= LEVELS_PER_SCALE_MAX)
      throw new AppError('VALIDATION_FAILED', 'Too many levels');
    assertFreeCode(scale, code);
    return {
      id: freeId(code, scale),
      code,
      description,
      createdBy: actor.by,
      createdAt: this.now(),
    };
  }

  /** A new code or description; the id and the items stay (AC-11). */
  rename(
    actor: LevelActor,
    target: { readonly topic: string; readonly level: string },
    input: LevelRename,
  ): Promise<TopicLevels> {
    return this.serial(async () => {
      const root = this.requireRoot(target.topic);
      const scale = this.deps.directory.scaleOf(root);
      const current = scale.find((one) => one.id === target.level);
      if (!current) throw unknownLevel();
      if (input.code !== undefined)
        assertFreeCode(scale, input.code, current.id);
      const next = { ...current, ...input };
      await this.deps.directory.changeScale(root, (levels) => ({
        next: levels.map((one) => (one.id === current.id ? next : one)),
        result: undefined,
      }));
      await this.record(actor, {
        kind: 'scale.rename',
        collection: root,
        target: current.id,
        before: { code: current.code, description: current.description },
        after: { code: next.code, description: next.description },
      });
      return this.levelsOf(root);
    });
  }

  /** The scale in a new order, lowest first; it applies at once to everyone (AC-12). */
  reorder(
    actor: LevelActor,
    topic: string,
    order: readonly string[],
  ): Promise<TopicLevels> {
    return this.serial(async () => {
      const root = this.requireRoot(topic);
      const scale = this.deps.directory.scaleOf(root);
      const ids = scale.map((one) => one.id);
      const same =
        order.length === ids.length &&
        new Set(order).size === ids.length &&
        order.every((id) => ids.includes(id));
      if (!same)
        throw new AppError('VALIDATION_FAILED', 'Name every level once');
      await this.deps.directory.changeScale(root, (levels) => ({
        next: order.flatMap((id) => levels.filter((one) => one.id === id)),
        result: undefined,
      }));
      await this.record(actor, {
        kind: 'scale.reorder',
        collection: root,
        before: ids,
        after: [...order],
      });
      return this.levelsOf(root);
    });
  }

  /** FR-4: one document's level, audited before → after. */
  setDocumentLevel(
    actor: LevelActor,
    target: DocumentTarget,
  ): Promise<{ level: ContentLevel }> {
    return this.serial(async () => {
      const { topic, id, level } = target;
      const entry = this.deps.catalog.get(topic)?.entries.get(id);
      if (!entry || isTrackEntry(entry))
        throw new AppError('DOCUMENT_NOT_FOUND', 'Document not found');
      const scale = this.deps.gate.scaleOf(topic);
      const chosen = scale.find((one) => one.id === level);
      if (!chosen)
        throw new AppError('VALIDATION_FAILED', 'Unknown level', {
          details: { field: 'level' },
        });
      const before = this.deps.directory.placementsOf(topic)[id]?.level ?? null;
      const placed = { level, setBy: actor.by, setAt: this.now() };
      await this.deps.directory.place({ [topic]: { [id]: placed } });
      await this.record(actor, {
        kind: 'item.level',
        collection: topic,
        target: id,
        before,
        after: level,
      });
      return { level: { id: chosen.id, code: chosen.code } };
    });
  }

  /** FR-3: each entry names a top-level collection with a scale and one of its levels. */
  assertLevels(levels: Readonly<Record<string, string>>): void {
    for (const [slug, level] of Object.entries(levels)) {
      const known =
        this.deps.catalog.get(slug) !== undefined &&
        this.deps.gate.rootOf(slug) === slug &&
        this.deps.directory.scaleOf(slug).some((one) => one.id === level);
      if (!known)
        throw new AppError('VALIDATION_FAILED', 'Unknown level', {
          details: { levels: slug },
        });
    }
  }

  /** FR-10: a person's level changes, one line each. */
  async recordChange(change: {
    readonly before: StoredPerson;
    readonly after: StoredPerson;
    readonly by: string;
  }): Promise<void> {
    const { before, after, by } = change;
    for (const [root, level] of Object.entries(after.levels ?? {})) {
      const was = before.levels?.[root] ?? null;
      if (was === level) continue;
      await this.record(
        { by },
        {
          kind: 'person.level',
          collection: root,
          target: after.id,
          before: was,
          after: level,
        },
      );
    }
  }

  /** BR-4: every text of the scope and every person with access, at the first level. */
  private async seed(
    actor: LevelActor,
    { root, level }: { readonly root: string; readonly level: string },
  ): Promise<void> {
    const placed = { level, setBy: actor.by, setAt: this.now() };
    const byCollection: Record<string, CollectionPlacements> = {};
    let documents = 0;
    for (const catalog of this.deps.catalog.scope(root)) {
      const texts = textsOf(catalog.entries.values());
      byCollection[catalog.topic.slug] = Object.fromEntries(
        texts.map((entry) => [entry.id, placed]),
      );
      documents += texts.length;
    }
    await this.deps.directory.place(byCollection);
    const ids = (await this.withAccess(root)).map((person) => person.id);
    await this.deps.people.placeLevels({ ids, root, level });
    await this.record(actor, {
      kind: 'bulk',
      collection: root,
      after: level,
      count: { documents, people: ids.length },
    });
  }

  /** People (not masters) who see the collection or one of its sub-collections. */
  private async withAccess(root: string): Promise<StoredPerson[]> {
    const scope = this.deps.catalog.scope(root).map((one) => one.topic.slug);
    return (await this.deps.people.list()).filter(
      (person) =>
        !isMaster(person) &&
        scope.some((slug) => canSeeTopic(person, slug, this.deps.parentOf)),
    );
  }

  /** Each text's level rank in the scope (-1: "Sem nível"). */
  private documentRanks(root: string, scale: readonly StoredLevel[]): number[] {
    return this.deps.catalog.scope(root).flatMap((catalog) => {
      const placed = this.deps.directory.placementsOf(catalog.topic.slug);
      return textsOf(catalog.entries.values()).map((entry) => {
        const level = placed[entry.id]?.level;
        return scale.findIndex((one) => one.id === level);
      });
    });
  }

  private async peopleRanks(root: string): Promise<number[]> {
    return (await this.withAccess(root)).map((person) =>
      this.deps.gate.personRank(person, root),
    );
  }

  /** The collection's own scale: a sub-collection has none (BR-1). */
  private requireRoot(topic: string): string {
    if (!this.deps.catalog.get(topic))
      throw new AppError('TOPIC_NOT_FOUND', 'Unknown topic');
    if (this.deps.gate.rootOf(topic) !== topic) throw subCollection();
    return topic;
  }

  private record(
    actor: LevelActor,
    entry: Omit<LevelAuditEntry, 'at' | 'by' | 'actingAs'>,
  ): Promise<void> {
    return this.deps.audit.append({
      at: this.now(),
      by: actor.by,
      ...(actor.actingAs && { actingAs: actor.actingAs }),
      ...entry,
    });
  }

  private serial<T>(run: () => Promise<T>): Promise<T> {
    const next = this.writing.then(run);
    this.writing = next.catch(() => undefined);
    return next;
  }

  private now(): string {
    return (this.deps.now?.() ?? new Date()).toISOString();
  }
}
