import type { Topic } from '@kb-chat/contracts';

/** The chips of Sua biblioteca (KBC-125 FR-5): what the list shows. */
export type LibraryKind =
  'collections' | 'audio' | 'conversations' | 'documents';
/** "Recentes" (last use first) or alphabetical. */
export type LibraryOrder = 'recent' | 'alpha';

export interface LibraryView {
  /** The chip on, or null for everything but the documents. */
  readonly kind: LibraryKind | null;
  readonly order: LibraryOrder;
  /** The text typed in the library's own search. */
  readonly query: string;
}

/** Which groups the list shows for a chip. */
export const shows = (kind: LibraryKind | null, group: LibraryKind): boolean =>
  kind === null ? group !== 'documents' : kind === group;

const folded = (text: string): string =>
  text.normalize('NFD').replace(/\p{M}/gu, '').toLocaleLowerCase('pt-BR');

/** Whether a title matches the library's search (accents and case ignored). */
export const matches = (title: string, query: string): boolean =>
  folded(title).includes(folded(query.trim()));

/**
 * The collections in the list, as a tree (KBC-048 FR-4): each sub-collection right under its
 * parent. Under "Recentes" the groups go by their last use (a parent counts its
 * sub-collections' too; the ones never chosen keep their order after them), else
 * alphabetically.
 */
export function orderCollections(
  topics: readonly Topic[],
  view: LibraryView,
  lastUse: Readonly<Record<string, number>>,
): Topic[] {
  const found = topics.filter((topic) => matches(topic.title, view.query));
  if (view.order === 'alpha') return alphabetical(found);
  const roots = rootsOf(found);
  const childrenOf = (root: Topic) =>
    found.filter((topic) => topic.parent === root.slug);
  const at = (root: Topic) =>
    Math.max(
      lastUse[root.slug] ?? 0,
      ...childrenOf(root).map((child) => lastUse[child.slug] ?? 0),
    );
  return roots
    .map((root, index) => ({ root, index }))
    .sort((a, b) => at(b.root) - at(a.root) || a.index - b.index)
    .flatMap(({ root }) => [root, ...childrenOf(root)]);
}

/** The top of each group: a collection whose parent is not in the list. */
const rootsOf = (topics: readonly Topic[]): Topic[] =>
  topics.filter(
    (topic) =>
      topic.parent === null || !topics.some((t) => t.slug === topic.parent),
  );

function alphabetical(topics: readonly Topic[]): Topic[] {
  const byTitle = (a: Topic, b: Topic) =>
    a.title.localeCompare(b.title, 'pt-BR');
  return rootsOf(topics)
    .sort(byTitle)
    .flatMap((root) => [
      root,
      ...topics.filter((topic) => topic.parent === root.slug).sort(byTitle),
    ]);
}

/** Conversations and documents: matching the search; alphabetical or as they come (recent). */
export function orderByTitle<T extends { readonly title: string }>(
  items: readonly T[],
  view: LibraryView,
): T[] {
  const found = items.filter((item) => matches(item.title, view.query));
  return view.order === 'alpha'
    ? [...found].sort((a, b) => a.title.localeCompare(b.title, 'pt-BR'))
    : found;
}

/** The recency groups of the conversations (D5): Hoje, Últimos 7 dias, Mais antigas. */
export type RecencyGroup = 'today' | 'week' | 'older';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The conversations split by when they last changed, in this browser's calendar: today,
 * the 7 days before it, and older. Each group keeps the order it was given; empty groups
 * are left out.
 */
export function groupByRecency<T extends { readonly updatedAt: string }>(
  items: readonly T[],
  now: Date,
): { readonly group: RecencyGroup; readonly items: T[] }[] {
  const today = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate(),
  ).getTime();
  const weekAgo = today - 7 * DAY_MS;
  const groups: Record<RecencyGroup, T[]> = { today: [], week: [], older: [] };
  for (const item of items) {
    const at = Date.parse(item.updatedAt);
    const group: RecencyGroup =
      at >= today ? 'today' : at >= weekAgo ? 'week' : 'older';
    groups[group].push(item);
  }
  return (['today', 'week', 'older'] as const)
    .filter((group) => groups[group].length > 0)
    .map((group) => ({ group, items: groups[group] }));
}

/** A collection of the tree with the sub-collections right under it. */
export interface CollectionNode<T extends { readonly topic: Topic }> {
  readonly entry: T;
  readonly children: T[];
}

/**
 * The ordered collections (as `orderCollections` gives them) as a tree of one level: each
 * group's top with its sub-collections, for the carets and the indentation (D5).
 */
export function collectionTree<T extends { readonly topic: Topic }>(
  entries: readonly T[],
): CollectionNode<T>[] {
  const slugs = new Set(entries.map((entry) => entry.topic.slug));
  const nodes: { entry: T; children: T[] }[] = [];
  const bySlug = new Map<string, { entry: T; children: T[] }>();
  for (const entry of entries) {
    const parent = entry.topic.parent;
    const node =
      parent !== null && slugs.has(parent) ? bySlug.get(parent) : undefined;
    if (node) node.children.push(entry);
    else {
      const root = { entry, children: [] as T[] };
      nodes.push(root);
      bySlug.set(entry.topic.slug, root);
    }
  }
  return nodes;
}
