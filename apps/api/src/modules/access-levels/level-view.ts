import type { ContentLevel } from '@kb-chat/contracts';
import {
  isTrackEntry,
  type CatalogEntry,
  type TopicCatalog,
} from '../catalog/index.js';
import type { CollectionPlacements, StoredLevel } from './level-directory.js';

/**
 * What one person may see of one collection and its sub-collections (ADR 0036 §6, §7): the
 * only way services reach content. Every set-based surface filters with `allows` before it
 * counts or groups.
 */
export interface LevelView {
  /** Every item is visible: a master, or a collection without levels. */
  readonly seesAll: boolean;
  /** The collection's top level has a scale. */
  readonly scaled: boolean;
  /** May see the levels of items (badges, "Mudar nível"): masters (BR-9). */
  readonly manages: boolean;
  /** Whether the viewer may see this document of `collection`. */
  allows(
    collection: string,
    entry: Pick<CatalogEntry, 'id' | 'media'>,
  ): boolean;
  /** Visible texts / texts of the collection, at least 0.05 (the candidate budget). */
  visibleShare(catalog: TopicCatalog): number;
  /** A document's level for whoever manages levels in a scaled collection; else undefined. */
  levelOf(collection: string, id: string): ContentLevel | undefined;
  /** The level ids the viewer sees, for SQL filters (KBC-105); null: every item. */
  allowedLevelIds(): readonly string[] | null;
}

/** The smallest share the budget assumes (ADR 0036 §7). */
export const MIN_VISIBLE_SHARE = 0.05;

/** A collection without levels, or no restriction at all. */
export const OPEN_VIEW: LevelView = {
  seesAll: true,
  scaled: false,
  manages: false,
  allows: () => true,
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
  visibleShare: () => MIN_VISIBLE_SHARE,
  levelOf: () => undefined,
  allowedLevelIds: () => [],
};

export interface ScaledViewInput {
  readonly scale: readonly StoredLevel[];
  /** The viewer's rank in the scale, or 'all' for a master. */
  readonly rank: number | 'all';
  readonly placementsOf: (collection: string) => CollectionPlacements;
  /** Memoizes the share per catalog load and state (NFR-1). */
  readonly memo: (catalog: TopicCatalog, compute: () => number) => number;
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

function shareOf(catalog: TopicCatalog, allows: LevelView['allows']): number {
  let texts = 0;
  let visible = 0;
  for (const entry of catalog.entries.values()) {
    if (isTrackEntry(entry)) continue;
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
    if (isTrackEntry(entry)) return false;
    const found = rankOf(scale, placementsOf(collection), entry.id);
    return found >= 0 && found <= rank;
  };
  return {
    seesAll,
    scaled: true,
    manages: seesAll,
    allows,
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
