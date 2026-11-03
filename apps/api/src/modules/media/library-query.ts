import {
  CONTINUE_LISTENING_MAX,
  LIBRARY_PAGE_SIZE,
  RECENTLY_PLAYED_MAX,
  listeningStateOf,
  type LibraryFacets,
  type LibraryItem,
  type LibrarySort,
  type ListeningState,
  type MediaAuthor,
  NO_AUTHOR,
} from '@kb-chat/contracts';

/**
 * The library's rules over the items a person sees (KBC-051): filters, search, sorting,
 * paging, the chips that exist, "Continuar ouvindo" and "Ouvidas recentemente". Pure, so
 * each rule is tested without the app.
 */

/** What "Buscar na biblioteca" matches besides the title: the author's name (KBC-049). */
const OTHER_AUTHORS_WORDS = 'outros autores';
const authorWordsOf = (author: MediaAuthor): string =>
  author?.name ?? OTHER_AUTHORS_WORDS;
/** The "Autoria" value of an item: its author's id, or NO_AUTHOR. */
const authorValueOf = (item: LibraryItem): string =>
  item.author?.slug ?? NO_AUTHOR;

/** Lower case, no accents, single spaces: "Laércio" is found by "laercio". */
export function normalizeText(text: string): string {
  return text
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

export interface LibraryFilter {
  readonly states: readonly ListeningState[];
  /** Author ids, NO_AUTHOR for "Outros autores". */
  readonly authors: readonly string[];
  /** The chosen collection and its sub-collections; null for every collection. */
  readonly topics: ReadonlySet<string> | null;
  readonly query: string;
}

const allows = <T>(chosen: readonly T[], value: T): boolean =>
  chosen.length === 0 || chosen.includes(value);

/** Title or author holds every word of the search (FR-1 `q`). */
export function matchesQuery(item: LibraryItem, query: string): boolean {
  const words = normalizeText(query).split(' ').filter(Boolean);
  if (words.length === 0) return true;
  const haystack = normalizeText(`${item.title} ${authorWordsOf(item.author)}`);
  return words.every((word) => haystack.includes(word));
}

/** Within a group the chips add up; across groups they narrow (state and author). */
export function filterLibrary(
  items: readonly LibraryItem[],
  filter: LibraryFilter,
): LibraryItem[] {
  return items.filter(
    (item) =>
      allows(filter.states, listeningStateOf(item)) &&
      allows(filter.authors, authorValueOf(item)) &&
      (filter.topics === null || filter.topics.has(item.topic)) &&
      matchesQuery(item, filter.query),
  );
}

const collator = new Intl.Collator('pt-BR', {
  sensitivity: 'base',
  numeric: true,
});
const newestFirst = (a: string | null, b: string | null): number =>
  (b ?? '').localeCompare(a ?? '');
const byAdded = (a: LibraryItem, b: LibraryItem): number =>
  newestFirst(a.createdAt, b.createdAt) || a.id.localeCompare(b.id);
const byTitle = (a: LibraryItem, b: LibraryItem): number =>
  collator.compare(a.title, b.title) || byAdded(a, b);

/** Each order, with a stable tie-break so pages never repeat or skip an item. */
const ORDERS: Record<LibrarySort, (a: LibraryItem, b: LibraryItem) => number> =
  {
    // Never played go last, newest added first among them.
    'recently-played': (a, b) =>
      newestFirst(a.lastPlayedAt, b.lastPlayedAt) || byAdded(a, b),
    'recently-added': byAdded,
    title: byTitle,
    // Shortest first; a media still converting (no length yet) goes last.
    duration: (a, b) =>
      (a.durationMs ?? Number.MAX_SAFE_INTEGER) -
        (b.durationMs ?? Number.MAX_SAFE_INTEGER) || byTitle(a, b),
    // By name; media with no author ("Outros autores") last.
    author: (a, b) =>
      Number(a.author === null) - Number(b.author === null) ||
      collator.compare(authorWordsOf(a.author), authorWordsOf(b.author)) ||
      byTitle(a, b),
  };

export function sortLibrary(
  items: readonly LibraryItem[],
  sort: LibrarySort,
): LibraryItem[] {
  return [...items].sort(ORDERS[sort]);
}

/** The states, authors and collections that exist (SL-16: no empty chip). */
export function facetsOf(items: readonly LibraryItem[]): LibraryFacets {
  const distinct = <T>(pick: (item: LibraryItem) => T): T[] => [
    ...new Set(items.map(pick)),
  ];
  return {
    states: distinct(listeningStateOf).sort(),
    authors: authorsOf(items),
    otherAuthors: items.some((item) => item.author === null),
    topics: distinct((item) => item.topic).sort(),
  };
}

/** Each author once (the first name seen), the main ones first, then by name. */
function authorsOf(items: readonly LibraryItem[]) {
  const bySlug = new Map<string, NonNullable<MediaAuthor>>();
  for (const { author } of items)
    if (author && !bySlug.has(author.slug)) bySlug.set(author.slug, author);
  return [...bySlug.values()].sort(
    (a, b) =>
      Number(b.main) - Number(a.main) || collator.compare(a.name, b.name),
  );
}

export interface LibrarySlice {
  readonly items: LibraryItem[];
  readonly nextCursor: string | null;
}

/** One page of 50; the cursor is where the next page starts (FR-1). */
export function pageOf(
  items: readonly LibraryItem[],
  cursor: string | undefined,
): LibrarySlice {
  const start = cursor === undefined ? 0 : Number(cursor);
  const end = start + LIBRARY_PAGE_SIZE;
  return {
    items: items.slice(start, end),
    nextCursor: end < items.length ? String(end) : null,
  };
}

const lastTouch = (item: LibraryItem): string | null =>
  item.lastPlayedAt ?? item.positionUpdatedAt;

/** BR-3: ready, in progress, the most recently played first, at most 10. */
export function continueListening(
  items: readonly LibraryItem[],
): LibraryItem[] {
  return items
    .filter(
      (item) =>
        item.status === 'ready' && listeningStateOf(item) === 'in-progress',
    )
    .sort((a, b) => newestFirst(lastTouch(a), lastTouch(b)) || byAdded(a, b))
    .slice(0, CONTINUE_LISTENING_MAX);
}

/** BR-4: the last 50 played, in any state, not before "Limpar recentes". */
export function recentlyPlayed(
  items: readonly LibraryItem[],
  clearedAt: string | null,
): LibraryItem[] {
  return items
    .filter(
      (item) =>
        item.status === 'ready' &&
        item.lastPlayedAt !== null &&
        (clearedAt === null || item.lastPlayedAt > clearedAt),
    )
    .sort(
      (a, b) => newestFirst(a.lastPlayedAt, b.lastPlayedAt) || byAdded(a, b),
    )
    .slice(0, RECENTLY_PLAYED_MAX);
}
