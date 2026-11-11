import type {
  LevelAuditEntry,
  LevelDelete,
  LevelPreview,
  LevelPreviewRequest,
  LevelsClear,
} from '@kb-chat/contracts';
import { AppError } from '../../app-error.js';
import type { LevelAuditPort } from '../../ports/level-audit.js';
import type { MediaStorePort, MovedMedia } from '../../ports/media-store.js';
import {
  canSeeTopic,
  isMaster,
  type HeldLevel,
  type StoredPerson,
} from '../auth/index.js';
import { assertVersion, type LevelActor } from './access-levels-service.js';
import type { CollectionPlacements, StoredLevel } from './level-directory.js';
import {
  impactOf,
  removalTargets,
  type ScaleChange,
  type ScaleImpact,
} from './level-impact.js';
import {
  assertWholeScale,
  holdingsOf,
  ownScaleRoot,
  scopeOf,
  type CountedHoldings,
  type HoldingsDeps,
} from './scale-holdings.js';
import { scaleVersion } from './scale-version.js';
import { applyAll, type UndoableStep } from './undo-steps.js';
import type { LevelWriteQueue } from './write-queue.js';

export interface ScaleChangesDeps extends Omit<
  HoldingsDeps,
  'people' | 'media'
> {
  /** The levels write queue shared with the other levels services. */
  readonly queue: LevelWriteQueue;
  readonly audit: LevelAuditPort;
  readonly people: HoldingsDeps['people'] & {
    rewriteLevels(change: {
      readonly root: string;
      readonly pick: (person: StoredPerson) => string | null | undefined;
    }): Promise<HeldLevel[]>;
  };
  readonly media?: Pick<
    MediaStorePort,
    'countLevels' | 'relevel' | 'restoreLevels'
  >;
  readonly now?: () => Date;
}

/** Who changes the scale, and the request's log (an undo that fails is told there). */
export interface ScaleCaller {
  readonly actor: LevelActor;
  readonly log: { error(fields: object, message: string): void };
}

/** What a removal or a clear moved, for its audit lines. */
interface Moved {
  media: MovedMedia[];
  documents: { collection: string; id: string; level: string }[];
  people: HeldLevel[];
}

/** Who and when, shared by every line of one operation. */
type AuditBase = Pick<LevelAuditEntry, 'at' | 'by' | 'actingAs'>;

const noneMoved = (): Moved => ({ media: [], documents: [], people: [] });

const NO_IMPACT = { people: 0, documents: 0, media: 0 };

const invalid = (message: string, field: string) =>
  new AppError('VALIDATION_FAILED', message, { details: { field } });

/** BR-1: both targets are other levels of the scale; the only level goes with every level (AC-6). */
function assertRemoval(
  scale: readonly StoredLevel[],
  level: StoredLevel,
  body: LevelDelete,
): void {
  if (scale.length === 1)
    throw invalid('The only level goes with every level', 'level');
  const targets = {
    moveContentTo: body.moveContentTo,
    movePeopleTo: body.movePeopleTo,
  };
  for (const [field, target] of Object.entries(targets))
    if (target === level.id || !scale.some((one) => one.id === target))
      throw invalid('Choose another level of the scale', field);
}

/**
 * Changes after the fact (KBC-108, ADR 0036 §10): the preview of a reorder or a removal, a
 * level deleted with targets for its content and its people, and every level taken away.
 * Writes run in the levels queue; each change is all or nothing over its stores (NFR-2).
 */
export class ScaleChangesService {
  constructor(private readonly deps: ScaleChangesDeps) {}

  /** FR-2: counts only, never a title or a name, on the scale the caller saw (BR-3). */
  async preview(
    topic: string,
    request: LevelPreviewRequest,
  ): Promise<LevelPreview> {
    const root = ownScaleRoot(this.deps, topic);
    const scale = this.deps.directory.scaleOf(root);
    assertVersion(scale, request.version);
    const held = await holdingsOf(this.deps, root);
    const ids = scale.map((one) => one.id);
    const version = scaleVersion(scale);
    if ('order' in request) {
      assertWholeScale(ids, request.order);
      const change = { before: ids, after: request.order };
      return { version, ...impactOf(change, held), removal: null };
    }
    return this.removalPreview({ scale, id: request.remove, held, version });
  }

  /** What the level holds, where it goes by default (BR-2) and who loses what. */
  private removalPreview(input: {
    readonly scale: readonly StoredLevel[];
    readonly id: string;
    readonly held: CountedHoldings;
    readonly version: string;
  }): LevelPreview {
    const { scale, held, version } = input;
    const level = this.levelIn(scale, input.id);
    const ids = scale.map((one) => one.id);
    const last = scale.length === 1;
    return {
      version,
      ...this.removalImpact({ ids, level: level.id, held, last }),
      removal: {
        level: { id: level.id, code: level.code },
        documents: held.documents[level.id] ?? 0,
        media: held.media[level.id] ?? 0,
        people: held.people[level.id] ?? 0,
        ...removalTargets(ids, level.id),
        last,
      },
    };
  }

  /** FR-1, BR-1: the level goes, its content and its people to the targets, in one operation. */
  remove(
    caller: ScaleCaller,
    target: { readonly topic: string; readonly level: string },
    body: LevelDelete,
  ): Promise<void> {
    return this.deps.queue.run(async () => {
      const root = ownScaleRoot(this.deps, target.topic);
      const scale = this.deps.directory.scaleOf(root);
      assertVersion(scale, body.version);
      const level = this.levelIn(scale, target.level);
      assertRemoval(scale, level, body);
      const change = { root, scale, level, body, moved: noneMoved() };
      await applyAll(this.removalSteps(caller.actor, change), caller.log);
    });
  }

  /** media.db, the documents, the people, the scale, then the audit (NFR-2). */
  private removalSteps(
    actor: LevelActor,
    change: {
      readonly root: string;
      readonly scale: readonly StoredLevel[];
      readonly level: StoredLevel;
      readonly body: LevelDelete;
      readonly moved: Moved;
    },
  ): UndoableStep[] {
    const { root, scale, level, body, moved } = change;
    const from = level.id;
    return [
      this.mediaStep({ root, from, to: body.moveContentTo }, moved),
      this.documentsStep(actor, change),
      this.peopleStep(change),
      this.scaleStep(
        root,
        scale.filter((one) => one.id !== from),
      ),
      this.auditStep(() => this.removalLines(actor, change)),
    ];
  }

  /** FR-3, BR-4: the collection goes back to no levels, confirmed by its slug. */
  clear(caller: ScaleCaller, topic: string, body: LevelsClear): Promise<void> {
    return this.deps.queue.run(async () => {
      const root = ownScaleRoot(this.deps, topic);
      if (body.confirm !== root)
        throw invalid('Type the collection to confirm', 'confirm');
      const scale = this.deps.directory.scaleOf(root);
      assertVersion(scale, body.version);
      if (scale.length === 0) return;
      const moved = noneMoved();
      await applyAll(
        [
          this.mediaStep({ root, to: null }, moved),
          this.clearDocumentsStep(root, moved),
          this.clearPresenceStep(root),
          this.clearPeopleStep(root, moved),
          this.scaleStep(root, []),
          this.auditStep(() =>
            this.clearLines(caller.actor, { root, scale, moved }),
          ),
        ],
        caller.log,
      );
    });
  }

  /** The removal's impact; the only level's is everyone seeing "Sem nível" too (BR-4). */
  private removalImpact(input: {
    readonly ids: readonly string[];
    readonly level: string;
    readonly held: CountedHoldings;
    readonly last: boolean;
  }): ScaleImpact {
    const { ids, level, held, last } = input;
    if (last) {
      const people = held.unassigned > 0 ? held.withAccess.length : 0;
      const gaining = { people, documents: held.unassigned, media: 0 };
      return { gaining, losing: NO_IMPACT };
    }
    const targets = removalTargets(ids, level);
    const change: ScaleChange = {
      before: ids,
      after: ids.filter((id) => id !== level),
      removal: {
        level,
        moveContentTo: targets.moveContentTo ?? level,
        movePeopleTo: targets.movePeopleTo ?? level,
      },
    };
    return impactOf(change, held);
  }

  private levelIn(scale: readonly StoredLevel[], id: string): StoredLevel {
    const level = scale.find((one) => one.id === id);
    if (!level) throw new AppError('NOT_FOUND', 'Unknown level');
    return level;
  }

  /** media.db in one transaction; its undo puts each row back at its level. */
  private mediaStep(
    change: {
      readonly root: string;
      readonly from?: string;
      readonly to: string | null;
    },
    moved: Moved,
  ): UndoableStep {
    const { media } = this.deps;
    const topics = scopeOf(this.deps.catalog, change.root);
    return {
      name: 'media',
      apply: async () => {
        moved.media = media?.relevel({ ...change, topics }) ?? [];
        return async () => media?.restoreLevels(moved.media);
      },
    };
  }

  /** document-levels.json: the level's documents to the content target. */
  private documentsStep(
    actor: LevelActor,
    change: {
      readonly root: string;
      readonly level: StoredLevel;
      readonly body: LevelDelete;
      readonly moved: Moved;
    },
  ): UndoableStep {
    const { root, level, body, moved } = change;
    const placed = {
      level: body.moveContentTo,
      setBy: actor.by,
      setAt: this.now(),
    };
    return this.placementsStep(root, (collection, placements) => {
      const next: Record<string, CollectionPlacements[string]> = {};
      for (const [id, one] of Object.entries(placements)) {
        const moves = one.level === level.id;
        next[id] = moves ? placed : one;
        if (moves) moved.documents.push({ collection, id, level: level.id });
      }
      return next;
    });
  }

  /** BR-4: no document of the scope keeps a level. */
  private clearDocumentsStep(root: string, moved: Moved): UndoableStep {
    return this.placementsStep(root, (collection, placements) => {
      for (const [id, one] of Object.entries(placements))
        moved.documents.push({ collection, id, level: one.level });
      return null;
    });
  }

  /** The scope's placements rewritten collection by collection; the undo writes them back. */
  private placementsStep(
    root: string,
    rewrite: (
      collection: string,
      placements: CollectionPlacements,
    ) => CollectionPlacements | null,
  ): UndoableStep {
    const { directory } = this.deps;
    return {
      name: 'documents',
      apply: async () => {
        const before: Record<string, CollectionPlacements> = {};
        const next: Record<string, CollectionPlacements | null> = {};
        for (const collection of scopeOf(this.deps.catalog, root)) {
          before[collection] = directory.placementsOf(collection);
          next[collection] = rewrite(collection, before[collection]);
        }
        await directory.replacePlacements(next);
        return () => directory.replacePlacements(before);
      },
    };
  }

  /** "Chegou em" of the scope's documents goes with the scale (BR-4). */
  private clearPresenceStep(root: string): UndoableStep {
    const { directory } = this.deps;
    return {
      name: 'presence',
      apply: async () => {
        const before = directory.presenceMap();
        const scope = new Set(scopeOf(this.deps.catalog, root));
        const next = Object.fromEntries(
          Object.entries(before).filter(([slug]) => !scope.has(slug)),
        );
        await directory.setPresence(next);
        return () => directory.setPresence(before);
      },
    };
  }

  /** people.json: whoever holds the level (an unknown or no entry at the lowest) to the people target. */
  private peopleStep(change: {
    readonly root: string;
    readonly scale: readonly StoredLevel[];
    readonly level: StoredLevel;
    readonly body: LevelDelete;
    readonly moved: Moved;
  }): UndoableStep {
    const { root, scale, level, body, moved } = change;
    const at = scale.indexOf(level);
    // Who counts in the level: its holders, and whoever reaches the collection with no
    // valid level (they hold the lowest, ADR 0036 §2).
    const holds = (person: StoredPerson) =>
      !isMaster(person) &&
      (person.levels?.[root] === level.id ||
        (this.reaches(person, root) &&
          this.deps.gate.personRank(person, root) === at));
    return this.rewriteStep(root, moved, (person) =>
      holds(person) ? body.movePeopleTo : undefined,
    );
  }

  /** BR-4: nobody keeps a level in the collection. */
  private clearPeopleStep(root: string, moved: Moved): UndoableStep {
    return this.rewriteStep(root, moved, (person) =>
      person.levels?.[root] === undefined ? undefined : null,
    );
  }

  private rewriteStep(
    root: string,
    moved: Moved,
    pick: (person: StoredPerson) => string | null | undefined,
  ): UndoableStep {
    const { people } = this.deps;
    return {
      name: 'people',
      apply: async () => {
        moved.people = await people.rewriteLevels({ root, pick });
        const held = new Map(moved.people.map((one) => [one.id, one.level]));
        return async () => {
          await people.rewriteLevels({
            root,
            pick: (person) =>
              held.has(person.id) ? (held.get(person.id) ?? null) : undefined,
          });
        };
      },
    };
  }

  private scaleStep(root: string, next: readonly StoredLevel[]): UndoableStep {
    const { directory } = this.deps;
    return {
      name: 'scale',
      apply: async () => {
        const before = directory.scaleOf(root);
        await directory.changeScale(root, () => ({ next, result: undefined }));
        return () =>
          directory.changeScale(root, () => ({
            next: before,
            result: undefined,
          }));
      },
    };
  }

  /** The audit last: a record that fails undoes the change (NFR-2), nothing is left unaudited. */
  private auditStep(lines: () => LevelAuditEntry[]): UndoableStep {
    return {
      name: 'audit',
      apply: async () => {
        await this.deps.audit.appendMany(lines());
        return async () => undefined;
      },
    };
  }

  private removalLines(
    actor: LevelActor,
    change: {
      readonly root: string;
      readonly level: StoredLevel;
      readonly body: LevelDelete;
      readonly moved: Moved;
    },
  ): LevelAuditEntry[] {
    const { root, level, body, moved } = change;
    // One moment for the whole operation: its lines read as one (AC-1).
    const base = this.base(actor);
    const head: LevelAuditEntry = {
      ...base,
      kind: 'scale.delete',
      collection: root,
      target: level.id,
      before: { code: level.code, description: level.description },
      after: {
        moveContentTo: body.moveContentTo,
        movePeopleTo: body.movePeopleTo,
      },
      count: this.countOf(moved),
    };
    return [
      head,
      ...this.itemLines(base, moved, body.moveContentTo),
      ...this.personLines(base, { root, moved, after: body.movePeopleTo }),
    ];
  }

  private clearLines(
    actor: LevelActor,
    change: {
      readonly root: string;
      readonly scale: readonly StoredLevel[];
      readonly moved: Moved;
    },
  ): LevelAuditEntry[] {
    const { root, scale, moved } = change;
    const base = this.base(actor);
    const head: LevelAuditEntry = {
      ...base,
      kind: 'scale.clear',
      collection: root,
      before: scale.map((one) => one.id),
      after: [],
      count: this.countOf(moved),
    };
    return [
      head,
      ...this.itemLines(base, moved, null),
      ...this.personLines(base, { root, moved, after: null }),
    ];
  }

  /** One `item.level` line per document and audio, to redo by hand (no automatic undo). */
  private itemLines(
    base: AuditBase,
    moved: Moved,
    after: string | null,
  ): LevelAuditEntry[] {
    const documents = moved.documents.map((one): LevelAuditEntry => ({
      ...base,
      kind: 'item.level',
      collection: one.collection,
      target: one.id,
      before: one.level,
      after,
    }));
    const media = moved.media.map((one): LevelAuditEntry => ({
      ...base,
      kind: 'item.level',
      collection: one.topic,
      target: one.id,
      before: one.level,
      after,
      count: { media: 1 },
    }));
    return [...documents, ...media];
  }

  private personLines(
    base: AuditBase,
    change: {
      readonly root: string;
      readonly moved: Moved;
      readonly after: string | null;
    },
  ): LevelAuditEntry[] {
    return change.moved.people.map((one): LevelAuditEntry => ({
      ...base,
      kind: 'person.level',
      collection: change.root,
      target: one.id,
      before: one.level,
      after: change.after,
    }));
  }

  private countOf(moved: Moved) {
    return {
      documents: moved.documents.length,
      media: moved.media.length,
      people: moved.people.length,
    };
  }

  private base(actor: LevelActor): AuditBase {
    return {
      at: this.now(),
      by: actor.by,
      ...(actor.actingAs && { actingAs: actor.actingAs }),
    };
  }

  private reaches(person: StoredPerson, root: string): boolean {
    return scopeOf(this.deps.catalog, root).some((slug) =>
      canSeeTopic(person, slug, this.deps.parentOf),
    );
  }

  private now(): string {
    return (this.deps.now?.() ?? new Date()).toISOString();
  }
}
