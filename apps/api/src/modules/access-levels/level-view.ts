import type {
  LevelView,
  ScopedDocument,
  ViewedCollection,
} from '../../ports/level-view.js';
import type { CollectionPlacements, StoredLevel } from './level-directory.js';

export type { LevelView } from '../../ports/level-view.js';

/** Whether a document of `scope` (a sub-collection's, by its home) is in the view. */
export const allowsInScope = (
  view: Pick<LevelView, 'allows'>,
  scope: string,
  entry: ScopedDocument,
): boolean =>
  view.allows(entry.home?.topic ?? scope, {
    id: entry.home?.id ?? entry.id,
    media: entry.media,
  });

/** The documents of a scope `allows` admits, in the scope's order. */
const visibleIn =
  (allows: LevelView['allows']): LevelView['entries'] =>
  (scope) =>
    [...scope.entries.values()].filter((entry) =>
      allowsInScope({ allows }, scope.topic, entry),
    );

/** The smallest share the budget assumes (ADR 0036 §7). */
export const MIN_VISIBLE_SHARE = 0.05;

/** A collection without levels, or no restriction at all. */
export const OPEN_VIEW: LevelView = {
  seesAll: true,
  scaled: false,
  manages: false,
  allows: () => true,
  entries: (scope) => [...scope.entries.values()],
  visibleShare: () => 1,
  levelOf: () => undefined,
  allowedLevelIds: () => null,
};

/**
 * Nothing visible: a sub-collection whose parent the catalog does not have (a reload in
 * flight, an orphan), whose scale cannot be known. Fail-closed for members.
 */
export const CLOSED_VIEW: LevelView = {
  seesAll: false,
  scaled: true,
  manages: false,
  allows: () => false,
  entries: () => [],
  visibleShare: () => MIN_VISIBLE_SHARE,
  levelOf: () => undefined,
  allowedLevelIds: () => [],
};

/** A turn with no collection at all (the AI connection test): nothing to see. */
export const NO_CONTENT_VIEW: LevelView = CLOSED_VIEW;

export interface ScaledViewInput {
  readonly scale: readonly StoredLevel[];
  /** The viewer's rank in the scale, or 'all' for a master. */
  readonly rank: number | 'all';
  readonly placementsOf: (collection: string) => CollectionPlacements;
  /** Memoizes the share per catalog load and state (NFR-1). */
  readonly memo: (catalog: ViewedCollection, compute: () => number) => number;
}

/** The rank of a document's level, or -1 for "Sem nível" (none, or one deleted since). */
function rankOf(
  scale: readonly StoredLevel[],
  placed: CollectionPlacements,
  id: string,
): number {
  const level = placed[id]?.level;
  return level === undefined ? -1 : scale.findIndex((one) => one.id === level);
}

function shareOf(
  catalog: ViewedCollection,
  allows: LevelView['allows'],
): number {
  let texts = 0;
  let visible = 0;
  for (const entry of catalog.entries.values()) {
    if (entry.media !== null) continue;
    texts += 1;
    if (allows(catalog.topic.slug, entry)) visible += 1;
  }
  return texts === 0 ? 1 : Math.max(MIN_VISIBLE_SHARE, visible / texts);
}

/** The view of a collection with a scale, for a master (`rank: 'all'`) or a person. */
export function scaledView(input: ScaledViewInput): LevelView {
  const { scale, rank, placementsOf, memo } = input;
  const seesAll = rank === 'all';
  const allows: LevelView['allows'] = (collection, entry) => {
    if (seesAll) return true;
    // A track's level lives in media.db (KBC-106); until then tracks stay closed.
    if (entry.media !== null) return false;
    const found = rankOf(scale, placementsOf(collection), entry.id);
    return found >= 0 && found <= rank;
  };
  return {
    seesAll,
    scaled: true,
    manages: seesAll,
    allows,
    entries: visibleIn(allows),
    visibleShare: (catalog) =>
      seesAll ? 1 : memo(catalog, () => shareOf(catalog, allows)),
    levelOf: (collection, id) => {
      if (!seesAll) return undefined;
      const found = scale[rankOf(scale, placementsOf(collection), id)];
      return found ? { id: found.id, code: found.code } : null;
    },
    allowedLevelIds: () =>
      seesAll ? null : scale.slice(0, rank + 1).map((one) => one.id),
  };
}
