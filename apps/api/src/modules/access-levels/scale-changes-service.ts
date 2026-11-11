import type {
  LevelDelete,
  LevelPreview,
  LevelPreviewRequest,
  LevelsClear,
} from '@kb-chat/contracts';
import { AppError } from '../../app-error.js';
import type { MediaStorePort } from '../../ports/media-store.js';
import { canSeeTopic, isMaster, type StoredPerson } from '../auth/index.js';
import { assertVersion, type LevelActor } from './access-levels-service.js';
import type { CollectionPlacements, StoredLevel } from './level-directory.js';
import { InvitePresetLevels } from './preset-levels.js';
import {
  auditBaseOf,
  clearLines,
  removalLines,
  undoneLine,
} from './scale-audit-lines.js';
import {
  holdingsOf,
  ownScaleRoot,
  scopeOf,
  type HoldingsDeps,
} from './scale-holdings.js';
import { levelIn, previewOf } from './scale-preview.js';
import {
  auditStep,
  mediaStep,
  noneMoved,
  peopleStep,
  placementsStep,
  presenceStep,
  scaleStep,
  type StepContext,
  type StepDeps,
} from './scale-steps.js';
import { applyAll, type UndoLog, type UndoableStep } from './undo-steps.js';
import type { LevelWriteQueue } from './write-queue.js';

export interface ScaleChangesDeps
  extends Omit<HoldingsDeps, 'people' | 'media'>, Omit<StepDeps, 'media'> {
  /** The levels write queue shared with the other levels services. */
  readonly queue: LevelWriteQueue;
  readonly people: HoldingsDeps['people'] & StepDeps['people'];
  readonly media?: Pick<
    MediaStorePort,
    'countLevels' | 'relevel' | 'restoreLevels'
  >;
  /** The invite profiles' levels (KBC-109); none bound: no profiles. */
  readonly presets?: InvitePresetLevels;
  readonly now?: () => Date;
}

/** Who changes the scale, and the request's log (an undo is told there). */
export interface ScaleCaller {
  readonly actor: LevelActor;
  readonly log: UndoLog;
}

const NO_PRESETS = new InvitePresetLevels();

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

/** What one removal needs, for its steps and its lines. */
interface Removal {
  readonly ctx: StepContext;
  readonly scale: readonly StoredLevel[];
  readonly level: StoredLevel;
  readonly body: LevelDelete;
  readonly base: ReturnType<typeof auditBaseOf>;
}

/**
 * Changes after the fact (KBC-108, ADR 0036 §10): the preview of a reorder, a removal or of
 * every level taken away, a level deleted with targets for its content and its people, and
 * every level taken away. Writes run in the levels queue; each is all or nothing (NFR-2).
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
    return previewOf({ root, scale, held, presets: this.presets() }, request);
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
      const level = levelIn(scale, target.level);
      assertRemoval(scale, level, body);
      const ctx = this.contextOf(root, caller.log);
      const base = auditBaseOf(caller.actor, this.now());
      const removal = { ctx, scale, level, body, base };
      await applyAll(this.removalSteps(removal), caller.log);
    });
  }

  /**
   * The scale first, so no other path can write the leaving level any more (upload, edit,
   * and the people and document writes queued behind this one, R1-4); then its audios, its
   * documents and its people; a second pass over media.db; the audit last. Undone in reverse:
   * the scale comes back last.
   */
  private removalSteps(removal: Removal): UndoableStep[] {
    const { ctx, scale, level, body, base } = removal;
    const moved = { from: level.id, to: body.moveContentTo };
    return [
      scaleStep(
        ctx,
        scale.filter((one) => one.id !== level.id),
      ),
      mediaStep(ctx, moved),
      this.documentsStep(removal),
      peopleStep(ctx, this.holderOf(removal)),
      mediaStep(ctx, moved),
      auditStep(ctx, {
        all: () =>
          removalLines(base, { ...removal, root: ctx.root, moved: ctx.moved }),
        undone: () => undoneLine(base, { root: ctx.root, target: level.id }),
        kind: 'scale.delete',
      }),
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
      const ctx = this.contextOf(root, caller.log);
      const base = auditBaseOf(caller.actor, this.now());
      await applyAll(this.clearSteps({ ctx, scale, base }), caller.log);
    });
  }

  /**
   * The items and people first and the scale after (removed first, it would open everything
   * while an undo puts levels back); a second pass over media.db catches an audio given a
   * level meanwhile; the audit last.
   */
  private clearSteps(clear: Omit<Removal, 'level' | 'body'>): UndoableStep[] {
    const { ctx, scale, base } = clear;
    const { root } = ctx;
    return [
      mediaStep(ctx, { to: null }),
      placementsStep(ctx, (collection, placements) => {
        for (const [id, one] of Object.entries(placements))
          ctx.moved.documents.push({ collection, id, level: one.level });
        return null;
      }),
      presenceStep(ctx),
      peopleStep(ctx, (person) =>
        person.levels?.[root] === undefined ? undefined : null,
      ),
      scaleStep(ctx, []),
      mediaStep(ctx, { to: null }),
      auditStep(ctx, {
        all: () => clearLines(base, { root, scale, moved: ctx.moved }),
        undone: () => undoneLine(base, { root }),
        kind: 'scale.clear',
      }),
    ];
  }

  /** document-levels.json: the level's documents to the content target. */
  private documentsStep(removal: Removal): UndoableStep {
    const { ctx, level, body, base } = removal;
    const placed = {
      level: body.moveContentTo,
      setBy: base.by,
      setAt: base.at,
    };
    return placementsStep(ctx, (collection, placements) => {
      const next: Record<string, CollectionPlacements[string]> = {};
      for (const [id, one] of Object.entries(placements)) {
        const moves = one.level === level.id;
        next[id] = moves ? placed : one;
        if (moves)
          ctx.moved.documents.push({ collection, id, level: level.id });
      }
      return next;
    });
  }

  /**
   * Who holds the leaving level, on the scale as it was (the step runs after the scale is
   * written): its holders, and, for the lowest, whoever reaches the collection with no level
   * of that scale (ADR 0036 §2).
   */
  private holderOf(removal: Removal) {
    const { ctx, scale, level, body } = removal;
    const { root } = ctx;
    const ids = new Set(scale.map((one) => one.id));
    const lowest = scale[0]?.id === level.id;
    return (person: StoredPerson): string | undefined => {
      if (isMaster(person)) return undefined;
      const held = person.levels?.[root];
      const holds =
        held === level.id ||
        (lowest &&
          (held === undefined || !ids.has(held)) &&
          this.reaches(person, root));
      return holds ? body.movePeopleTo : undefined;
    };
  }

  private contextOf(root: string, log: UndoLog): StepContext {
    return { deps: this.deps, root, moved: noneMoved(), log };
  }

  private reaches(person: StoredPerson, root: string): boolean {
    return scopeOf(this.deps.catalog, root).some((slug) =>
      canSeeTopic(person, slug, this.deps.parentOf),
    );
  }

  private presets(): InvitePresetLevels {
    return this.deps.presets ?? NO_PRESETS;
  }

  private now(): string {
    return (this.deps.now?.() ?? new Date()).toISOString();
  }
}
