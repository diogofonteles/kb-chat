import type { LevelAuditEntry } from '@kb-chat/contracts';
import type { LevelAuditPort } from '../../ports/level-audit.js';
import type { MediaStorePort, MovedMedia } from '../../ports/media-store.js';
import type { HeldLevel, StoredPerson } from '../auth/index.js';
import type { CatalogRegistry } from '../catalog/index.js';
import type {
  CollectionPlacements,
  LevelDirectory,
  StoredLevel,
} from './level-directory.js';
import { scopeOf } from './scale-holdings.js';
import type { Undo, UndoLog, UndoableStep } from './undo-steps.js';

/** The stores a scale change writes. */
export interface StepDeps {
  readonly directory: LevelDirectory;
  readonly catalog: CatalogRegistry;
  readonly audit: LevelAuditPort;
  readonly people: {
    rewriteLevels(change: {
      readonly root: string;
      readonly pick: (person: StoredPerson) => string | null | undefined;
    }): Promise<HeldLevel[]>;
  };
  readonly media?: Pick<MediaStorePort, 'relevel' | 'restoreLevels'>;
}

/** What a removal or a clear moved, for its audit lines. */
export interface Moved {
  media: MovedMedia[];
  documents: { collection: string; id: string; level: string }[];
  people: HeldLevel[];
}

export const noneMoved = (): Moved => ({
  media: [],
  documents: [],
  people: [],
});

/** One operation's stores, collection, log and what it moved. */
export interface StepContext {
  readonly deps: StepDeps;
  readonly root: string;
  readonly moved: Moved;
  readonly log: UndoLog;
}

/** The ids a log line names: the first ones, with the total (as KBC-107's, R1-5). */
const LOGGED_IDS_MAX = 50;

const beforeOf = (
  root: string,
  rows: readonly { readonly id: string; readonly level: string | null }[],
) => ({
  collection: root,
  total: rows.length,
  before: rows.slice(0, LOGGED_IDS_MAX).map(({ id, level }) => ({ id, level })),
});

/** An undo found writes made meanwhile and left them (R1-3). */
function warnSkipped(
  ctx: StepContext,
  step: string,
  skipped: readonly string[],
): void {
  if (skipped.length === 0) return;
  ctx.log.warn(
    {
      step,
      collection: ctx.root,
      total: skipped.length,
      skipped: skipped.slice(0, LOGGED_IDS_MAX),
    },
    'level change undo left a write made meanwhile',
  );
}

/** access-levels.json: the scale as `next`; the undo writes it back as it was. */
export function scaleStep(
  ctx: StepContext,
  next: readonly StoredLevel[],
): UndoableStep {
  const { directory } = ctx.deps;
  return {
    name: 'scale',
    apply: async () => {
      const before = directory.scaleOf(ctx.root);
      await directory.changeScale(ctx.root, () => ({
        next,
        result: undefined,
      }));
      return {
        run: () =>
          directory.changeScale(ctx.root, () => ({
            next: before,
            result: undefined,
          })),
      };
    },
  };
}

/**
 * media.db in one transaction (a second call sweeps rows written meanwhile, R1-4); the undo
 * puts back only rows still at what it wrote (R1-3).
 */
export function mediaStep(
  ctx: StepContext,
  change: { readonly from?: string; readonly to: string | null },
): UndoableStep {
  const { media, catalog } = ctx.deps;
  return {
    name: 'media',
    apply: async () => {
      const topics = scopeOf(catalog, ctx.root);
      const rows = media?.relevel({ ...change, topics }) ?? [];
      ctx.moved.media.push(...rows);
      const undo: Undo = {
        run: async () => {
          const back = rows.map((row) => ({ ...row, written: change.to }));
          warnSkipped(ctx, 'media', media?.restoreLevels(back) ?? []);
        },
        before: () => beforeOf(ctx.root, rows),
      };
      return undo;
    },
  };
}

type Rewrite = (
  collection: string,
  placements: CollectionPlacements,
) => CollectionPlacements | null;

/** What the undo writes for one collection: the entry before, where it still is what was written. */
function restoredOf(state: {
  readonly before: CollectionPlacements;
  readonly written: CollectionPlacements;
  readonly now: CollectionPlacements;
  readonly skipped: string[];
}): CollectionPlacements {
  const { before, written, now, skipped } = state;
  const ids = new Set([...Object.keys(before), ...Object.keys(now)]);
  const restored: Record<string, CollectionPlacements[string]> = {};
  for (const id of ids) {
    const untouched = now[id]?.level === written[id]?.level;
    const kept = untouched ? before[id] : now[id];
    if (!untouched) skipped.push(id);
    if (kept) restored[id] = kept;
  }
  return restored;
}

/** document-levels.json, collection by collection; the undo writes back what is unchanged since. */
export function placementsStep(
  ctx: StepContext,
  rewrite: Rewrite,
): UndoableStep {
  const { directory, catalog } = ctx.deps;
  return {
    name: 'documents',
    apply: async () => {
      const before: Record<string, CollectionPlacements> = {};
      const next: Record<string, CollectionPlacements | null> = {};
      for (const collection of scopeOf(catalog, ctx.root)) {
        before[collection] = directory.placementsOf(collection);
        next[collection] = rewrite(collection, before[collection]);
      }
      await directory.replacePlacements(next);
      return {
        run: () => undoPlacements(ctx, { before, next }),
        before: () => beforeOf(ctx.root, ctx.moved.documents),
      };
    },
  };
}

/** Each collection back as it was, but for entries written meanwhile (R1-3). */
async function undoPlacements(
  ctx: StepContext,
  step: {
    readonly before: Readonly<Record<string, CollectionPlacements>>;
    readonly next: Readonly<Record<string, CollectionPlacements | null>>;
  },
): Promise<void> {
  const { directory } = ctx.deps;
  const skipped: string[] = [];
  const back = Object.fromEntries(
    Object.entries(step.before).map(([collection, was]) => [
      collection,
      restoredOf({
        before: was,
        written: step.next[collection] ?? {},
        now: directory.placementsOf(collection),
        skipped,
      }),
    ]),
  );
  await directory.replacePlacements(back);
  warnSkipped(ctx, 'documents', skipped);
}

const NOTHING: Undo = { run: async () => undefined };

/** "Chegou em" of the scope goes with the scale (BR-4); nothing there, nothing written (QA-3). */
export function presenceStep(ctx: StepContext): UndoableStep {
  const { directory, catalog } = ctx.deps;
  return {
    name: 'presence',
    apply: async () => {
      const before = directory.presenceMap();
      const scope = new Set(scopeOf(catalog, ctx.root));
      const kept = Object.entries(before).filter(([slug]) => !scope.has(slug));
      if (kept.length === Object.keys(before).length) return NOTHING;
      await directory.setPresence(Object.fromEntries(kept));
      return { run: () => directory.setPresence(before) };
    },
  };
}

/**
 * people.json: each person's level in the collection as `pick` says; the undo puts back only
 * whoever still holds what was written (R1-3).
 */
export function peopleStep(
  ctx: StepContext,
  pick: (person: StoredPerson) => string | null | undefined,
): UndoableStep {
  const { people } = ctx.deps;
  const { root } = ctx;
  return {
    name: 'people',
    apply: async () => {
      const written = new Map<string, string | null>();
      const recording = (person: StoredPerson) => {
        const level = pick(person);
        if (level !== undefined) written.set(person.id, level);
        return level;
      };
      const changed = await people.rewriteLevels({ root, pick: recording });
      ctx.moved.people.push(...changed);
      const undo: Undo = {
        run: () => undoPeople(ctx, { changed, written }),
        before: () => beforeOf(root, changed),
      };
      return undo;
    },
  };
}

/** Whoever still holds what the step wrote goes back; anyone changed since stays (R1-3). */
async function undoPeople(
  ctx: StepContext,
  step: {
    readonly changed: readonly HeldLevel[];
    readonly written: ReadonlyMap<string, string | null>;
  },
): Promise<void> {
  const { root } = ctx;
  const held = new Map(step.changed.map((one) => [one.id, one.level]));
  const skipped: string[] = [];
  await ctx.deps.people.rewriteLevels({
    root,
    pick: (person) => {
      if (!held.has(person.id)) return undefined;
      const now = person.levels?.[root] ?? null;
      if (now === step.written.get(person.id)) return held.get(person.id);
      skipped.push(person.id);
      return undefined;
    },
  });
  warnSkipped(ctx, 'people', skipped);
}

/**
 * The audit last, in one append. When it fails after lines may have reached the file, a
 * `scale.undone` line says so and the history leaves the operation out (R1-5).
 */
export function auditStep(
  ctx: StepContext,
  lines: {
    readonly all: () => LevelAuditEntry[];
    readonly undone: () => LevelAuditEntry;
    /** The operation's own kind, for the log when its mark fails too (R2-4). */
    readonly kind: 'scale.delete' | 'scale.clear';
  },
): UndoableStep {
  const { audit } = ctx.deps;
  return {
    name: 'audit',
    apply: async () => {
      try {
        await audit.appendMany(lines.all());
      } catch (err) {
        const mark = lines.undone();
        await audit
          .append(mark, { freshLine: true })
          .catch((cause: unknown) => {
            ctx.log.error(
              {
                err: cause,
                collection: ctx.root,
                at: mark.at,
                by: mark.by,
                kind: lines.kind,
              },
              'level change undone but not marked in the audit',
            );
          });
        throw err;
      }
      return NOTHING;
    },
  };
}
