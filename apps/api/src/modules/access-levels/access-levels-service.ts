import {
  LEVELS_PER_SCALE_MAX,
  foldLevelCode,
  levelCreateSchema,
  levelIdOf,
  levelIdSchema,
  type LevelAuditEntry,
  type LevelCreate,
  type LevelRename,
  type LevelScales,
  type TopicLevels,
} from '@kb-chat/contracts';
import { AppError } from '../../app-error.js';
import { LevelWriteQueue } from './write-queue.js';
import type { LevelAuditPort } from '../../ports/level-audit.js';
import type { MediaStorePort } from '../../ports/media-store.js';
import type { ParentOf, StoredPerson } from '../auth/index.js';
import type { CatalogRegistry } from '../catalog/index.js';
import type { ContentGate } from './content-gate.js';
import {
  holdingsOf,
  assertWholeScale,
  ownScaleRoot,
  peopleWithAccess,
  textsOf,
} from './scale-holdings.js';
import { scaleVersion } from './scale-version.js';
import type { InvitePresetLevels } from './preset-levels.js';
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
  /** Shared with the other levels service (R1-7); its own when absent. */
  readonly queue?: LevelWriteQueue;
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
  /** The invite profiles' levels: an id they still name is not given again (QA-2). */
  readonly presets?: InvitePresetLevels;
  readonly parentOf: ParentOf;
  /** The media library's audios, placed with the documents (KBC-105); absent with media off. */
  readonly media?: Pick<MediaStorePort, 'seedLevel' | 'countLevels'>;
  readonly now?: () => Date;
}

/** Who the app's own writes are recorded as (the start's seed). */
const APP_ACTOR: LevelActor = { by: 'kb-chat' };

const unknownLevel = () => new AppError('NOT_FOUND', 'Unknown level');
const codeTaken = (code: string) =>
  new AppError('LEVEL_CODE_TAKEN', 'A level with that code exists', {
    details: { code },
  });

/** BR-3 of KBC-108: a change confirmed on a preview of another scale is refused. */
export function assertVersion(
  scale: readonly StoredLevel[],
  version: string,
): void {
  if (scaleVersion(scale) !== version)
    throw new AppError('LEVELS_CHANGED', 'The scale changed since the preview');
}

/**
 * An id no level has, nor any reference still names: the code's, with -2, -3… when a renamed
 * level kept it, or when a deleted level's id is still named by a profile or a person (QA-2:
 * a new "CI" never silently becomes the level an old profile asked for).
 */
function freeId(code: string, taken: ReadonlySet<string>): string {
  const base = levelIdOf(code);
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
export class AccessLevelsService {
  private readonly queue: LevelWriteQueue;

  constructor(private readonly deps: AccessLevelsServiceDeps) {
    this.queue = deps.queue ?? new LevelWriteQueue();
  }

  /** GET …/levels: the scale with its counts and version (T24, KBC-108 FR-5). */
  async levelsOf(topic: string): Promise<TopicLevels> {
    if (!this.deps.catalog.get(topic))
      throw new AppError('TOPIC_NOT_FOUND', 'Unknown topic');
    const root = this.deps.gate.rootOf(topic);
    const scale = this.deps.directory.scaleOf(root);
    const held = await holdingsOf(this.deps, root);
    return {
      collection: root,
      inherited: root !== topic,
      levels: scale.map((level, rank) => ({
        id: level.id,
        code: level.code,
        description: level.description,
        documents: held.documents[level.id] ?? 0,
        // Whoever holds no level of the scale sits at the lowest (ADR 0036 §2).
        people: (held.people[level.id] ?? 0) + (rank === 0 ? held.implicit : 0),
        media: held.media[level.id] ?? 0,
      })),
      documents: held.texts,
      people: held.withAccess.length,
      unassigned: scale.length === 0 ? 0 : held.unassigned,
      version: scaleVersion(scale),
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
      const taken = await this.takenIds(root, scale);
      const level = this.newLevel(actor, { scale, code, description, taken });
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
      readonly taken: ReadonlySet<string>;
    },
  ): StoredLevel {
    const { scale, code, description, taken } = input;
    if (scale.length >= LEVELS_PER_SCALE_MAX)
      throw new AppError('VALIDATION_FAILED', 'Too many levels');
    assertFreeCode(scale, code);
    return {
      id: freeId(code, taken),
      code,
      description,
      createdBy: actor.by,
      createdAt: this.now(),
    };
  }

  /** The ids of the scale and those a profile or a person still names in the collection. */
  private async takenIds(
    root: string,
    scale: readonly StoredLevel[],
  ): Promise<Set<string>> {
    const people = await this.deps.people.list();
    return new Set([
      ...scale.map((one) => one.id),
      ...(this.deps.presets?.idsIn(root) ?? []),
      ...people.flatMap((one) => {
        const level = one.levels?.[root];
        return level === undefined ? [] : [level];
      }),
    ]);
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

  /**
   * The scale in a new order, lowest first; it applies at once to everyone (AC-12), while the
   * scale is the one its preview was made on (KBC-108 BR-3).
   */
  reorder(
    actor: LevelActor,
    topic: string,
    change: { readonly order: readonly string[]; readonly version: string },
  ): Promise<TopicLevels> {
    const { order } = change;
    return this.serial(async () => {
      const root = this.requireRoot(topic);
      const scale = this.deps.directory.scaleOf(root);
      assertVersion(scale, change.version);
      const ids = scale.map((one) => one.id);
      assertWholeScale(ids, order);
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
    const ids = (await peopleWithAccess(this.deps, root)).map(
      (person) => person.id,
    );
    await this.deps.people.placeLevels({ ids, root, level });
    const media = this.seedMedia({ root, level, again: true }) ?? 0;
    await this.record(actor, {
      kind: 'bulk',
      collection: root,
      after: level,
      count: { documents, people: ids.length, media },
    });
  }

  /**
   * KBC-105 AC-10: at start, the audios of each collection whose scale came before audios
   * held a level go to its lowest one, once (a row written later by an older image stays
   * "Sem nível", masters only, BR-8). Audited as one bulk event per collection.
   */
  seedMediaAtStart(log?: {
    error(fields: object, message: string): void;
  }): Promise<void> {
    return this.serial(async () => {
      for (const catalog of this.deps.catalog.topics()) {
        const root = catalog.topic.slug;
        if (this.deps.gate.rootOf(root) !== root) continue;
        const [lowest] = this.deps.directory.scaleOf(root);
        if (!lowest) continue;
        const media = this.seedMedia({ root, level: lowest.id, again: false });
        if (media === null) continue;
        // The seed is marked in media.db's transaction and its record follows (the audit
        // file cannot join it). A failed record is logged with what was placed and fails
        // this start; the next one finds the mark and goes on, so the log line is then the
        // only trace (ADR 0036 §11, KBC-105 review round 2).
        await this.record(APP_ACTOR, {
          kind: 'bulk',
          collection: root,
          after: lowest.id,
          count: { media },
        }).catch((err: unknown) => {
          log?.error(
            { err, collection: root, level: lowest.id, media },
            'media levels seeded but not audited',
          );
          throw err;
        });
      }
    });
  }

  /** The audios of the scope with no level, at `level`; null: seeded before (at start). */
  private seedMedia(seed: {
    readonly root: string;
    readonly level: string;
    readonly again: boolean;
  }): number | null {
    const { media } = this.deps;
    if (!media) return null;
    const topics = this.deps.catalog
      .scope(seed.root)
      .map((one) => one.topic.slug);
    return media.seedLevel({ ...seed, topics, now: new Date(this.now()) });
  }

  /** The collection's own scale: a sub-collection has none (BR-1). */
  private requireRoot(topic: string): string {
    return ownScaleRoot(this.deps, topic);
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
    return this.queue.run(run);
  }

  private now(): string {
    return (this.deps.now?.() ?? new Date()).toISOString();
  }
}
