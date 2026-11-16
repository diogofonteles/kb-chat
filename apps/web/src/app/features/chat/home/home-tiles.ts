import type { ConversationSummary, Topic } from '@kb-chat/contracts';

/** The home shows up to six recent shortcuts, in a 2×3 grid (KBC-126 FR-1). */
export const MAX_TILES = 6;

/** One recent shortcut: a conversation of the history or a collection. */
export type HomeTile =
  | {
      readonly kind: 'conversation';
      readonly key: string;
      readonly conversation: ConversationSummary;
    }
  | {
      readonly kind: 'collection';
      readonly key: string;
      readonly topic: Topic;
    };

/**
 * The home's recent shortcuts (KBC-126 FR-1, BR-5): the conversations of the server's
 * history in the order of their last use, then, while there is room, the collections those
 * conversations used and the other collections the person sees. Only collections the
 * person can open today come in (KBC-110): a conversation title is the person's own
 * question, never a document's.
 */
export function homeTiles(
  conversations: readonly ConversationSummary[],
  topics: readonly Topic[],
): HomeTile[] {
  const recent = [...conversations]
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, MAX_TILES);
  const openable = new Map(
    topics.filter((topic) => topic.canOpen).map((topic) => [topic.slug, topic]),
  );
  const used = [...new Set(recent.map((one) => one.topic))];
  const collections = collectionsBy(used, openable);
  return [
    ...recent.map((conversation): HomeTile => ({
      kind: 'conversation',
      key: `conversation:${conversation.id}`,
      conversation,
    })),
    ...collections.map((topic): HomeTile => ({
      kind: 'collection',
      key: `collection:${topic.slug}`,
      topic,
    })),
  ].slice(0, MAX_TILES);
}

/** The collections the recent conversations used, then the others the person sees. */
function collectionsBy(
  used: readonly string[],
  openable: ReadonlyMap<string, Topic>,
): Topic[] {
  return [
    ...used.flatMap((slug) => {
      const topic = openable.get(slug);
      return topic ? [topic] : [];
    }),
    ...[...openable.values()].filter((topic) => !used.includes(topic.slug)),
  ];
}
