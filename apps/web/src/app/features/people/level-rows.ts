import type { LevelChoice, LevelScales, Topic } from '@kb-chat/contracts';

type Scales = LevelScales['items'];
type Levels = Readonly<Record<string, string>>;

/** "Nível em <acervo>" for one top-level collection with levels (T9, KBC-103, KBC-109). */
export interface LevelRow {
  readonly collection: string;
  readonly title: string;
  readonly choices: readonly LevelChoice[];
  /** The level held when it exists, else the lowest (KBC-103 BR-5, KBC-109 BR-3). */
  readonly current: string;
}

/** A master, or nothing reached: no select. */
export const NO_LEVEL_ROWS: ReadonlyMap<string, LevelRow> = new Map();

/** The collection or one of its sub-collections is granted, by the tree (ADR 0028). */
const reaches = (
  topics: readonly Topic[],
  granted: readonly string[],
  root: string,
): boolean =>
  granted.includes(root) ||
  topics.some((topic) => topic.parent === root && granted.includes(topic.slug));

/** The collections with levels that `granted` reaches, lowest level first in each. */
function reachedScales(
  topics: readonly Topic[],
  granted: readonly string[],
  scales: Scales,
): Scales {
  return scales.filter(
    ({ collection, levels }) =>
      levels.length > 0 && reaches(topics, granted, collection),
  );
}

/**
 * Each select keyed by the slug of the last row of its collection's group, so it sits right
 * under the collection and its sub-collections (T9 emenda 2026-11-06).
 */
export function levelRowsAfter(
  topics: readonly Topic[],
  scales: Scales,
  held: { readonly granted: readonly string[]; readonly levels: Levels },
): ReadonlyMap<string, LevelRow> {
  const rows = new Map<string, LevelRow>();
  for (const { collection, levels } of reachedScales(
    topics,
    held.granted,
    scales,
  )) {
    const group = topics.filter(
      (topic) => topic.slug === collection || topic.parent === collection,
    );
    const last = group.at(-1)?.slug ?? collection;
    const wanted = held.levels[collection];
    rows.set(last, {
      collection,
      title: group[0]?.title ?? collection,
      choices: levels,
      current: levels.some((one) => one.id === wanted)
        ? (wanted ?? '')
        : (levels[0]?.id ?? ''),
    });
  }
  return rows;
}

/**
 * The levels a preset keeps (KBC-109 BR-1): one per collection with levels it reaches, the one
 * chosen or the lowest; none for a collection left unmarked or for a master (BR-5).
 */
export function presetLevels(
  preset: {
    readonly role: string;
    readonly topics: readonly string[];
    readonly levels?: Levels;
  },
  topics: readonly Topic[],
  scales: Scales,
): Record<string, string> {
  if (preset.role === 'master') return {};
  const kept: Record<string, string> = {};
  for (const { collection, levels } of reachedScales(
    topics,
    preset.topics,
    scales,
  )) {
    const wanted = preset.levels?.[collection];
    const level = levels.some((one) => one.id === wanted)
      ? wanted
      : levels[0]?.id;
    if (level) kept[collection] = level;
  }
  return kept;
}

/** The preset with `presetLevels`; none is undefined, so no key goes out (as the API keeps it). */
export function withPresetLevels<
  T extends {
    readonly role: string;
    readonly topics: readonly string[];
    readonly levels?: Levels;
  },
>(preset: T, topics: readonly Topic[], scales: Scales): T {
  const levels = presetLevels(preset, topics, scales);
  return {
    ...preset,
    levels: Object.keys(levels).length > 0 ? levels : undefined,
  };
}
