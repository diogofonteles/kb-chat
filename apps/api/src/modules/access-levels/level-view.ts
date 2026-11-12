import type {
  LevelView,
  PlacedTrack,
  ScopedDocument,
  TrackPlace,
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
  trackPlace: () => null,
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
  trackPlace: () => null,
};

/** A turn with no collection at all (the AI connection test): nothing to see. */
export const NO_CONTENT_VIEW: LevelView = CLOSED_VIEW;

export interface ScaledViewInput {
  readonly scale: readonly StoredLevel[];
  /** The viewer's rank in the scale, or 'all' for a master. */
  readonly rank: number | 'all';
  /**
   * Holds `content-levels` (KBC-107 BR-1): also sees the documents without a level, and the
   * badges of what they see.
   */
  readonly classifier?: boolean;
  readonly placementsOf: (collection: string) => CollectionPlacements;
  /**
   * The level media.db holds for a track's document (KBC-106, ADR 0036 §3): null "Sem nível",
   * undefined unknown; both closed to members. Absent: no media, no track seen.
   */
  readonly mediaLevelOf?: (mediaId: string) => string | null | undefined;
  /** The live tracks of the recording a track belongs to (KBC-111); absent: no media. */
  readonly tracksBeside?: (mediaId: string) => readonly PlacedTrack[];
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

/** §6 for one viewer: a text by its placement, a track by its level in media.db. */
function allowsFor(
  input: ScaledViewInput,
  manages: boolean,
): LevelView['allows'] {
  const { scale, rank, placementsOf } = input;
  return (collection, entry) => {
    if (rank === 'all') return true;
    // A track's level lives in media.db (KBC-106): its own, or its recording's.
    if (entry.media !== null) {
      const level = input.mediaLevelOf?.(entry.media.mediaId);
      const found = scale.findIndex((one) => one.id === level);
      return found >= 0 && found <= rank;
    }
    const found = rankOf(scale, placementsOf(collection), entry.id);
    if (found < 0) return manages;
    return found <= rank;
  };
}

/** The view of a collection with a scale, for a master (`rank: 'all'`) or a person. */
export function scaledView(input: ScaledViewInput): LevelView {
  const { scale, rank, placementsOf, memo } = input;
  const seesAll = rank === 'all';
  const manages = seesAll || input.classifier === true;
  const allows = allowsFor(input, manages);
  return {
    seesAll,
    scaled: true,
    manages,
    allows,
    entries: visibleIn(allows),
    visibleShare: (catalog) =>
      seesAll ? 1 : memo(catalog, () => shareOf(catalog, allows)),
    levelOf: (collection, id) => {
      if (!manages) return undefined;
      const found = scale[rankOf(scale, placementsOf(collection), id)];
      return found ? { id: found.id, code: found.code } : null;
    },
    allowedLevelIds: () =>
      seesAll ? null : scale.slice(0, rank + 1).map((one) => one.id),
    trackPlace: placesFor(input, rank),
  };
}

/**
 * The view's `trackPlace`: null for a master or without media; else the place among what
 * the viewer hears, the recording's tracks read once per view (every track of it is cached).
 */
function placesFor(
  input: ScaledViewInput,
  rank: number | 'all',
): LevelView['trackPlace'] {
  const { tracksBeside } = input;
  if (rank === 'all' || !tracksBeside) return () => null;
  const heard = input.scale.slice(0, rank + 1);
  const known = new Map<string, readonly PlacedTrack[]>();
  return (mediaId) => {
    let tracks = known.get(mediaId);
    if (!tracks) {
      tracks = tracksBeside(mediaId);
      for (const track of tracks) known.set(track.mediaId, tracks);
    }
    return placeAmong(tracks, mediaId, heard);
  };
}

/** The track's place among the live tracks at the levels the viewer holds. */
function placeAmong(
  tracks: readonly PlacedTrack[],
  mediaId: string,
  heard: readonly StoredLevel[],
): TrackPlace {
  const ids = heard.map((one) => one.id);
  const order = [
    ...new Set(
      [...tracks]
        .sort((a, b) => a.startMs - b.startMs)
        .filter((track) => track.level !== null && ids.includes(track.level))
        .map((track) => track.mediaId),
    ),
  ];
  const at = order.indexOf(mediaId);
  return { ordinal: at < 0 ? null : at + 1, total: order.length };
}
