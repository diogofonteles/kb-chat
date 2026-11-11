import type { LevelImpact } from '@kb-chat/contracts';

/** What a scale holds, by level id: texts, audios and people (KBC-108 FR-2). */
export interface ScaleHoldings {
  readonly documents: Readonly<Record<string, number>>;
  readonly media: Readonly<Record<string, number>>;
  /** People (not masters) with access, by the level they hold (the lowest when none). */
  readonly people: Readonly<Record<string, number>>;
}

/** A scale before and after a change, and where a removed level's items and people go. */
export interface ScaleChange {
  /** Level ids, lowest first. */
  readonly before: readonly string[];
  readonly after: readonly string[];
  /** The removed level and its targets (BR-1), when it is a removal. */
  readonly removal?: {
    readonly level: string;
    readonly moveContentTo: string;
    readonly movePeopleTo: string;
  };
}

export interface ScaleImpact {
  readonly gaining: LevelImpact;
  readonly losing: LevelImpact;
}

/** The default targets of a removal (BR-2): content up (fail-closed), people down (least privilege). */
export function removalTargets(
  ids: readonly string[],
  level: string,
): { moveContentTo: string | null; movePeopleTo: string | null } {
  const at = ids.indexOf(level);
  return {
    moveContentTo: ids[at + 1] ?? ids[at - 1] ?? null,
    movePeopleTo: ids[at - 1] ?? ids[at + 1] ?? null,
  };
}

const itemsOf = (holdings: ScaleHoldings, levels: Iterable<string>) => {
  let documents = 0;
  let media = 0;
  for (const level of levels) {
    documents += holdings.documents[level] ?? 0;
    media += holdings.media[level] ?? 0;
  }
  return { documents, media };
};

/** The levels whose items one person at `level` starts (or stops) seeing. */
function changedSight(change: ScaleChange, level: string) {
  const { before, after, removal } = change;
  const contentOf = (id: string) =>
    id === removal?.level ? removal.moveContentTo : id;
  const personAt = level === removal?.level ? removal.movePeopleTo : level;
  const was = before.indexOf(level);
  const now = after.indexOf(personAt);
  const sees = (id: string) => after.indexOf(contentOf(id)) <= now;
  return {
    gains: before.filter((id) => before.indexOf(id) > was && sees(id)),
    loses: before.filter((id) => before.indexOf(id) <= was && !sees(id)),
  };
}

const hasItems = (holdings: ScaleHoldings, levels: readonly string[]) => {
  const { documents, media } = itemsOf(holdings, levels);
  return documents + media > 0;
};

/**
 * Who gains and who loses sight of how many items (KBC-108 FR-2, UP-07): people grouped by
 * the level they hold, items by theirs, never a name or a title. Items count once however
 * many people gain them.
 */
export function impactOf(
  change: ScaleChange,
  holdings: ScaleHoldings,
): ScaleImpact {
  const gained = new Set<string>();
  const lost = new Set<string>();
  let gaining = 0;
  let losing = 0;
  for (const level of change.before) {
    const people = holdings.people[level] ?? 0;
    if (people === 0) continue;
    const { gains, loses } = changedSight(change, level);
    if (hasItems(holdings, gains)) gaining += people;
    if (hasItems(holdings, loses)) losing += people;
    gains.forEach((id) => gained.add(id));
    loses.forEach((id) => lost.add(id));
  }
  return {
    gaining: { people: gaining, ...itemsOf(holdings, gained) },
    losing: { people: losing, ...itemsOf(holdings, lost) },
  };
}
