import type {
  LevelAuditEntry,
  PeopleLevelRequest,
  PeopleLevelResult,
  PersonLevelVia,
} from '@kb-chat/contracts';
import { AppError } from '../../app-error.js';
import type { LevelAuditPort } from '../../ports/level-audit.js';
import {
  canSeeTopic,
  isMaster,
  type LevelChanged,
  type LevelGrant,
  type ParentOf,
  type PersonLevelRules,
  type StoredPerson,
} from '../auth/index.js';
import type { CatalogRegistry } from '../catalog/index.js';
import type { LevelActor } from './access-levels-service.js';
import type { ContentGate } from './content-gate.js';
import type { LevelDirectory, StoredLevel } from './level-directory.js';
import { LevelWriteQueue } from './write-queue.js';

export interface PeopleLevelsDeps {
  /** Shared with the other levels services: a scale change never slips into a bulk. */
  readonly queue?: LevelWriteQueue;
  readonly directory: LevelDirectory;
  readonly catalog: CatalogRegistry;
  readonly gate: ContentGate;
  readonly audit: LevelAuditPort;
  readonly parentOf: ParentOf;
  readonly people: {
    setLevels(change: {
      readonly root: string;
      readonly level: string;
      readonly keeps: (person: StoredPerson) => boolean;
    }): Promise<LevelChanged[]>;
  };
  readonly now?: () => Date;
}

/** The master who sets the bulk and the request's log (a record that fails is told there). */
export interface BulkCaller {
  readonly actor: LevelActor;
  readonly log: { error(fields: object, message: string): void };
}

type Levels = Readonly<Record<string, string>>;

const unknownLevel = (collection: string) =>
  new AppError('VALIDATION_FAILED', 'Unknown level', {
    details: { levels: collection },
  });

/** Who a bulk left as they were, counted while people.json is being changed. */
interface Tally {
  seen: number;
  unchanged: number;
  masters: number;
  withoutAccess: number;
}

/** What a bulk changed, for its audit. */
interface BulkChange {
  readonly root: string;
  readonly level: string;
  readonly changed: readonly LevelChanged[];
  readonly named: ReadonlySet<string> | null;
  readonly skipped: number;
}

/**
 * People's levels (KBC-103 FR-3, KBC-109): checked and resolved for the person editor,
 * invitations and profiles, set in bulk, and audited person by person (ADR 0036 §9, §11).
 */
export class PeopleLevelsService implements PersonLevelRules {
  private readonly queue: LevelWriteQueue;

  constructor(private readonly deps: PeopleLevelsDeps) {
    this.queue = deps.queue ?? new LevelWriteQueue();
  }

  /** FR-3 of KBC-103: each entry names a top-level collection with a scale and one of its levels. */
  assertLevels(levels: Levels): void {
    for (const [root, level] of Object.entries(levels))
      if (!this.isRoot(root) || !this.has(root, level))
        throw unknownLevel(root);
  }

  /** BR-1, BR-5: a collection the preset reaches, with a scale holding that level. */
  assertPresetLevels(preset: LevelGrant): void {
    const entries = Object.entries(preset.levels ?? {});
    if (entries.length === 0) return;
    if (preset.role === 'master')
      throw new AppError('VALIDATION_FAILED', 'A master holds no levels');
    const reached = new Set(this.reachedRoots(preset.topics));
    for (const [root, level] of entries)
      if (!reached.has(root) || !this.has(root, level))
        throw unknownLevel(root);
  }

  /** BR-2, BR-3: the level named when it exists, else the held one, else the lowest. */
  resolve(
    grant: LevelGrant & { readonly held?: Levels },
  ): Record<string, string> {
    if (grant.role === 'master') return {};
    const named = grant.levels ?? {};
    const held = grant.held ?? {};
    const resolved: Record<string, string> = {};
    for (const root of this.reachedRoots(grant.topics)) {
      const level = this.pick(root, { named, held });
      if (level) resolved[root] = level;
    }
    return resolved;
  }

  /** FR-4: the levels a preset keeps that their collection's scale no longer has. */
  staleLevels(preset: { readonly levels?: Levels }): Record<string, string> {
    return Object.fromEntries(
      Object.entries(preset.levels ?? {}).filter(
        ([root, level]) =>
          this.scale(root).length > 0 && !this.has(root, level),
      ),
    );
  }

  /** One line per collection whose level changed, in one write (BR-4). */
  async recordChange(change: {
    readonly before: StoredPerson;
    readonly after: StoredPerson;
    readonly by: string;
    readonly via: PersonLevelVia;
  }): Promise<void> {
    const { before, after, by, via } = change;
    const at = this.now();
    const lines = Object.entries(after.levels ?? {})
      .filter(([root, level]) => (before.levels?.[root] ?? null) !== level)
      .map(([root, level]): LevelAuditEntry => ({
        at,
        by,
        kind: 'person.level',
        collection: root,
        target: after.id,
        before: before.levels?.[root] ?? null,
        after: level,
        via,
      }));
    if (lines.length > 0) await this.deps.audit.appendMany(lines);
  }

  /** FR-3: one level for the people named (or everyone), one write of people.json (NFR-1). */
  assign(
    caller: BulkCaller,
    request: PeopleLevelRequest,
  ): Promise<PeopleLevelResult> {
    return this.queue.run(async () => {
      const { topic: root, level } = request;
      const choice = this.choiceOf(root, level);
      const named = 'ids' in request ? new Set(request.ids) : null;
      const { changed, tally } = await this.place({ root, level, named });
      const unknown = named ? named.size - tally.seen : 0;
      const skipped = tally.masters + tally.withoutAccess + unknown;
      await this.recordBulk(caller, { root, level, changed, named, skipped });
      return {
        collection: root,
        level: choice,
        updated: changed.length,
        unchanged: tally.unchanged,
        masters: tally.masters,
        withoutAccess: tally.withoutAccess,
        unknown,
      };
    });
  }

  /** The people.json write, counting whom it leaves while it runs. */
  private async place(target: {
    readonly root: string;
    readonly level: string;
    readonly named: ReadonlySet<string> | null;
  }): Promise<{ changed: LevelChanged[]; tally: Tally }> {
    const tally: Tally = {
      seen: 0,
      unchanged: 0,
      masters: 0,
      withoutAccess: 0,
    };
    const changed = await this.deps.people.setLevels({
      root: target.root,
      level: target.level,
      keeps: (person) => this.counts(person, { ...target, tally }),
    });
    return { changed, tally };
  }

  /** Whether the bulk changes this person; who it leaves is counted (AC-6). */
  private counts(
    person: StoredPerson,
    target: {
      readonly root: string;
      readonly level: string;
      readonly named: ReadonlySet<string> | null;
      readonly tally: Tally;
    },
  ): boolean {
    const { root, level, named, tally } = target;
    if (named && !named.has(person.id)) return false;
    tally.seen += 1;
    if (isMaster(person)) tally.masters += 1;
    else if (!this.reaches(person, root)) tally.withoutAccess += 1;
    else if (person.levels?.[root] === level) tally.unchanged += 1;
    else return true;
    return false;
  }

  /**
   * One `bulk` line and one `person.level` line per person, in one append. People are written
   * first (the audit file cannot join that write): a failed record is logged with what changed
   * and fails the request (ADR 0036 §11).
   */
  private async recordBulk(
    caller: BulkCaller,
    bulk: BulkChange,
  ): Promise<void> {
    const { root, level, changed } = bulk;
    const lines = this.bulkLines(caller.actor, bulk);
    await this.deps.audit.appendMany(lines).catch((err: unknown) => {
      caller.log.error(
        {
          err,
          collection: root,
          level,
          people: changed.map((one) => one.person.id),
        },
        'people levels changed but not audited',
      );
      throw err;
    });
  }

  private bulkLines(actor: LevelActor, bulk: BulkChange): LevelAuditEntry[] {
    const { root, level, changed, named, skipped } = bulk;
    const base = {
      at: this.now(),
      by: actor.by,
      ...(actor.actingAs && { actingAs: actor.actingAs }),
      collection: root,
      via: 'bulk' as const,
    };
    return [
      {
        ...base,
        kind: 'bulk',
        after: level,
        count: { people: changed.length, skipped },
        ...(named && { filter: { ids: named.size } }),
      },
      ...changed.map(({ person, before }): LevelAuditEntry => ({
        ...base,
        kind: 'person.level',
        target: person.id,
        before,
        after: level,
      })),
    ];
  }

  /** The level as a choice; 400 for a collection without that level (FR-3). */
  private choiceOf(root: string, level: string): { id: string; code: string } {
    const found = this.isRoot(root)
      ? this.scale(root).find((one) => one.id === level)
      : undefined;
    if (!found) throw unknownLevel(root);
    return { id: found.id, code: found.code };
  }

  private pick(
    root: string,
    known: { readonly named: Levels; readonly held: Levels },
  ): string | undefined {
    const { named, held } = known;
    const wanted = named[root];
    if (wanted !== undefined && this.has(root, wanted)) return wanted;
    const kept = held[root];
    if (wanted === undefined && kept !== undefined && this.has(root, kept))
      return undefined;
    return this.scale(root)[0]?.id;
  }

  /** The top-level collections with a scale that these collections reach. */
  private reachedRoots(topics: readonly string[]): string[] {
    const roots = topics
      .filter((slug) => this.deps.catalog.get(slug) !== undefined)
      .map((slug) => this.deps.gate.rootOf(slug));
    return [...new Set(roots)].filter((root) => this.scale(root).length > 0);
  }

  /** The person sees the collection or one of its sub-collections. */
  private reaches(person: StoredPerson, root: string): boolean {
    return this.deps.catalog
      .scope(root)
      .some((one) => canSeeTopic(person, one.topic.slug, this.deps.parentOf));
  }

  private isRoot(slug: string): boolean {
    return (
      this.deps.catalog.get(slug) !== undefined &&
      this.deps.gate.rootOf(slug) === slug
    );
  }

  private scale(root: string): readonly StoredLevel[] {
    return this.deps.directory.scaleOf(root);
  }

  private has(root: string, level: string): boolean {
    return this.scale(root).some((one) => one.id === level);
  }

  private now(): string {
    return (this.deps.now?.() ?? new Date()).toISOString();
  }
}
