import { AppError } from '../../app-error.js';
import type { MediaStorePort } from '../../ports/media-store.js';
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
import type { ContentGate } from './content-gate.js';
import type { ScaleHoldings } from './level-impact.js';
import type { LevelDirectory } from './level-directory.js';

/** What counting a scale's holdings reads. */
export interface HoldingsDeps {
  readonly directory: LevelDirectory;
  readonly catalog: CatalogRegistry;
  readonly gate: ContentGate;
  readonly parentOf: ParentOf;
  readonly people: { list(): Promise<readonly StoredPerson[]> };
  /** The audios of media.db; absent with media off. */
  readonly media?: Pick<MediaStorePort, 'countLevels'>;
}

/** A scale's holdings, and the totals T24 shows (KBC-103 FR-1, KBC-108 FR-2). */
export interface CountedHoldings extends ScaleHoldings {
  /** Texts of the scope (track documents take their level from media.db, KBC-106). */
  readonly texts: number;
  readonly withAccess: readonly StoredPerson[];
}

/** Texts of a collection: track documents take their level from media.db (KBC-106). */
export const textsOf = (entries: Iterable<CatalogEntry>): CatalogEntry[] =>
  [...entries].filter((entry) => !isTrackEntry(entry));

/** The collection and its sub-collections. */
export const scopeOf = (catalog: CatalogRegistry, root: string): string[] =>
  catalog.scope(root).map((one) => one.topic.slug);

/** People (not masters) who see the collection or one of its sub-collections. */
export async function peopleWithAccess(
  deps: Pick<HoldingsDeps, 'catalog' | 'parentOf' | 'people'>,
  root: string,
): Promise<StoredPerson[]> {
  const scope = scopeOf(deps.catalog, root);
  return (await deps.people.list()).filter(
    (person) =>
      !isMaster(person) &&
      scope.some((slug) => canSeeTopic(person, slug, deps.parentOf)),
  );
}

const bump = (counts: Record<string, number>, key: string) => {
  counts[key] = (counts[key] ?? 0) + 1;
};

/** Each text's level in the scope, counted by level id. */
function documentCounts(deps: HoldingsDeps, root: string) {
  const ids = new Set(deps.directory.scaleOf(root).map((one) => one.id));
  const documents: Record<string, number> = {};
  let texts = 0;
  let unassigned = 0;
  for (const catalog of deps.catalog.scope(root)) {
    const placed = deps.directory.placementsOf(catalog.topic.slug);
    const levels = textsOf(catalog.entries.values()).map(
      (entry) => placed[entry.id]?.level,
    );
    texts += levels.length;
    const known = levels.filter(
      (level): level is string => level !== undefined && ids.has(level),
    );
    known.forEach((level) => bump(documents, level));
    unassigned += levels.length - known.length;
  }
  return { documents, texts, unassigned };
}

/** What each level of a top-level collection's scale holds: texts, audios and people. */
export async function holdingsOf(
  deps: HoldingsDeps,
  root: string,
): Promise<CountedHoldings> {
  const scale = deps.directory.scaleOf(root);
  const withAccess = await peopleWithAccess(deps, root);
  const ids = new Set(scale.map((one) => one.id));
  const people: Record<string, number> = {};
  let implicit = 0;
  for (const person of withAccess) {
    const held = person.levels?.[root];
    if (held !== undefined && ids.has(held)) bump(people, held);
    else implicit += 1;
  }
  const media = deps.media?.countLevels(scopeOf(deps.catalog, root)) ?? {};
  return {
    ...documentCounts(deps, root),
    media,
    people,
    implicit,
    withAccess,
  };
}

/** The collection's own scale: a sub-collection has none (KBC-103 BR-1). */
export function ownScaleRoot(
  deps: Pick<HoldingsDeps, 'catalog' | 'gate'>,
  topic: string,
): string {
  const catalog = deps.catalog.get(topic);
  if (!catalog) throw new AppError('TOPIC_NOT_FOUND', 'Unknown topic');
  // An orphan sub-collection still declares its parent: a scale on it would be inert
  // once the parent is back (review round 2).
  if (catalog.topic.parent || deps.gate.rootOf(topic) !== topic)
    throw new AppError(
      'VALIDATION_FAILED',
      'A sub-collection uses its parent levels',
    );
  return topic;
}

/** A new order names every level of the scale once (KBC-103 AC-12). */
export function assertWholeScale(
  ids: readonly string[],
  order: readonly string[],
): void {
  const same =
    order.length === ids.length &&
    new Set(order).size === ids.length &&
    order.every((id) => ids.includes(id));
  if (!same) throw new AppError('VALIDATION_FAILED', 'Name every level once');
}
