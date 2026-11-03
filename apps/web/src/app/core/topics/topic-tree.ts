import type { Topic } from '@kb-chat/contracts';

/** A sub-collection's indent in a native select, the only one a `<select>` keeps (ADR 0028). */
const INDENT = '\u00a0'.repeat(4);

/** The name as a tree row: sub-collections indented under their parent (KBC-048 FR-4). */
export const treeTitle = (topic: Pick<Topic, 'title' | 'parent'>): string =>
  topic.parent === null ? topic.title : `${INDENT}${topic.title}`;

/** Collections a person may pick: a parent shown only as a group title is left out. */
export const openable = (topics: readonly Topic[]): readonly Topic[] =>
  topics.filter((topic) => topic.canOpen);

/** A collection as a checkbox row of "Pessoas e permissões" and the invite profiles (FR-5). */
export interface CollectionChoice extends Topic {
  readonly checked: boolean;
  /** Given through the parent (BR-3): checked and locked until the parent is unchecked. */
  readonly inherited: boolean;
  readonly parentTitle: string;
}

/** The tree of checkboxes for what `granted` holds (a master: everything). */
export function collectionChoices(
  topics: readonly Topic[],
  granted: readonly string[],
  all: boolean,
): CollectionChoice[] {
  const titles = new Map(topics.map((topic) => [topic.slug, topic.title]));
  return topics.map((topic) => {
    const inherited =
      !all && topic.parent !== null && granted.includes(topic.parent);
    return {
      ...topic,
      inherited,
      parentTitle:
        topic.parent === null ? '' : (titles.get(topic.parent) ?? ''),
      checked: all || inherited || granted.includes(topic.slug),
    };
  });
}

const collator = new Intl.Collator('pt-BR', { sensitivity: 'base' });
const byTitle = (a: Topic, b: Topic): number =>
  collator.compare(a.title, b.title);

/**
 * The list with `topic` added or replaced, in the server's tree order: top level by name, each
 * followed by its sub-collections by name (KBC-048 FR-4).
 */
export function withTopic(
  topics: readonly Topic[],
  topic: Topic,
): readonly Topic[] {
  const all = [...topics.filter((one) => one.slug !== topic.slug), topic];
  const known = new Set(all.map((one) => one.slug));
  const roots = all
    .filter((one) => one.parent === null || !known.has(one.parent))
    .sort(byTitle);
  return roots.flatMap((root) => [
    root,
    ...all.filter((one) => one.parent === root.slug).sort(byTitle),
  ]);
}
