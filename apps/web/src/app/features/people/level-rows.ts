import type { LevelChoice, LevelScales, Topic } from '@kb-chat/contracts';

/** The collections with access levels (`Scales | null` where they may still be loading). */
export type Scales = LevelScales['items'];
type Levels = Readonly<Record<string, string>>;

/**
 * Where a level select is: the person editor (her level, the lowest when none), an invitation
 * (the level it gives, the lowest by default) or a profile, where a collection the profile does
 * not name keeps each person's level when it is applied (KBC-109 BR-2, R1-2).
 */
export type LevelMode = 'person' | 'invite' | 'profile';

/** "Manter o nível da pessoa": the profile names no level for that collection. */
export const KEEP_LEVEL = ':keep';
/** "Escolha": a level the profile keeps that no longer exists (R1-3). */
export const CHOOSE_LEVEL = ':choose';

/** "Nível em <acervo>" for one top-level collection with levels (T9, KBC-103, KBC-109). */
export interface LevelRow {
  readonly collection: string;
  readonly title: string;
  readonly choices: readonly LevelChoice[];
  /** A level id, KEEP_LEVEL or CHOOSE_LEVEL. */
  readonly current: string;
  /** The level kept that no longer exists, while it is the one kept. */
  readonly stale: string | null;
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

/** What the select shows for a collection, by where it is. */
function currentOf(
  choices: readonly LevelChoice[],
  wanted: string | undefined,
  mode: LevelMode,
): { readonly current: string; readonly stale: string | null } {
  if (wanted !== undefined && choices.some((one) => one.id === wanted))
    return { current: wanted, stale: null };
  if (mode !== 'profile') return { current: choices[0]?.id ?? '', stale: null };
  return wanted === undefined
    ? { current: KEEP_LEVEL, stale: null }
    : { current: CHOOSE_LEVEL, stale: wanted };
}

/**
 * Each select keyed by the slug of the last row of its collection's group, so it sits right
 * under the collection and its sub-collections (T9 emenda 2026-11-06).
 */
export function levelRowsAfter(
  topics: readonly Topic[],
  scales: Scales,
  held: {
    readonly granted: readonly string[];
    readonly levels: Levels;
    readonly mode: LevelMode;
  },
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
    rows.set(last, {
      collection,
      title: group[0]?.title ?? collection,
      choices: levels,
      ...currentOf(levels, held.levels[collection], held.mode),
    });
  }
  return rows;
}

/**
 * The levels a preset keeps (KBC-109 BR-1): none for a collection left unmarked or for a
 * master (BR-5). An invitation gives each collection it reaches the level chosen, else the
 * lowest; a profile keeps only the levels it names, as they are (R1-2).
 */
export function presetLevels(
  preset: {
    readonly role: string;
    readonly topics: readonly string[];
    readonly levels?: Levels;
  },
  context: {
    readonly topics: readonly Topic[];
    readonly scales: Scales;
    readonly mode: Exclude<LevelMode, 'person'>;
  },
): Record<string, string> {
  const { topics, scales, mode } = context;
  if (preset.role === 'master') return {};
  const kept: Record<string, string> = {};
  for (const { collection, levels } of reachedScales(
    topics,
    preset.topics,
    scales,
  )) {
    const wanted = preset.levels?.[collection];
    const valid = levels.some((one) => one.id === wanted);
    const level = mode === 'profile' ? wanted : valid ? wanted : levels[0]?.id;
    if (level) kept[collection] = level;
  }
  return kept;
}

/**
 * The preset with `presetLevels`; none is undefined, so no key goes out (as the API keeps it).
 * Without the scales (loading, or failed) the levels stay as they came (R1-1).
 */
export function withPresetLevels<
  T extends {
    readonly role: string;
    readonly topics: readonly string[];
    readonly levels?: Levels;
  },
>(
  preset: T,
  context: {
    readonly topics: readonly Topic[];
    readonly scales: Scales | null;
    readonly mode: Exclude<LevelMode, 'person'>;
  },
): T {
  const { topics, scales, mode } = context;
  const levels =
    scales === null
      ? reachedLevels(preset, topics)
      : presetLevels(preset, { topics, scales, mode });
  return {
    ...preset,
    levels: Object.keys(levels).length > 0 ? levels : undefined,
  };
}

/**
 * Without the scales: the levels as they came, less those of a collection the preset no
 * longer reaches or of a master, which only the tree says (QA-r2-1).
 */
function reachedLevels(
  preset: {
    readonly role: string;
    readonly topics: readonly string[];
    readonly levels?: Levels;
  },
  topics: readonly Topic[],
): Record<string, string> {
  if (preset.role === 'master') return {};
  return Object.fromEntries(
    Object.entries(preset.levels ?? {}).filter(([root]) =>
      reaches(topics, preset.topics, root),
    ),
  );
}

/** A profile's level that no longer exists, still kept: the profile waits for a choice. */
export const hasStaleLevel = (
  levels: Levels | undefined,
  scales: Scales | null,
): boolean =>
  scales !== null &&
  Object.entries(levels ?? {}).some(([root, level]) => {
    const scale = scales.find((one) => one.collection === root);
    return !!scale && !scale.levels.some((one) => one.id === level);
  });
