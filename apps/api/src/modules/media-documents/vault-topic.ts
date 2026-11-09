import { TOPIC_TITLE_MAX, type KbCollection } from '@kb-chat/contracts';
import type { TopicFolder } from '../../ports/vault-reader.js';

/** What a new vault topic is filed under when nothing else says (KBC-114 BR-4). */
export const FALLBACK_DOMAIN = 'geral';

const DOMAIN = /^[a-z0-9][a-z0-9-]{0,59}$/;

/** A domain as `kb topic new` takes it here: one lowercase word; null when none is left. */
export const toDomain = (value: string | undefined): string | null => {
  const word = (value ?? '')
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/, '');
  return DOMAIN.test(word) ? word : null;
};

/** The vault's most used domain (a tie goes to the first in alphabetical order). */
const mostUsedDomain = (topics: readonly TopicFolder[]): string | null => {
  const counts = new Map<string, number>();
  for (const topic of topics) {
    if (topic.screenOnly) continue;
    const domain = toDomain(topic.domain);
    if (domain) counts.set(domain, (counts.get(domain) ?? 0) + 1);
  }
  const ranked = [...counts].sort(
    ([a, countA], [b, countB]) => countB - countA || a.localeCompare(b),
  );
  return ranked[0]?.[0] ?? null;
};

/**
 * The domain of a collection's vault topic (KBC-114 BR-4): its own when the vault has it;
 * for one created on the screen, its parent's, else the vault's most used, else `geral`.
 */
export function domainOfTopic(
  topics: readonly TopicFolder[],
  slug: string,
): string {
  const bySlug = new Map(topics.map((one) => [one.slug, one]));
  const own = toDomain(bySlug.get(slug)?.domain);
  if (own) return own;
  const parent = bySlug.get(slug)?.parent;
  const inherited = parent ? toDomain(bySlug.get(parent)?.domain) : null;
  return inherited ?? mostUsedDomain(topics) ?? FALLBACK_DOMAIN;
}

const titleOf = (topic: TopicFolder): string =>
  (topic.title.trim() || topic.slug).slice(0, TOPIC_TITLE_MAX);

/**
 * What the Mac needs to create a collection's vault topic (KBC-114 FR-2): its title and
 * domain, and its parent's for a sub-collection. Null for a collection the app does not know.
 */
export function collectionOf(
  topics: readonly TopicFolder[],
  slug: string,
): KbCollection | null {
  const topic = topics.find((one) => one.slug === slug);
  if (!topic) return null;
  const parentSlug = slug.includes('/') ? slug.split('/')[0] : undefined;
  const parent = parentSlug
    ? topics.find((one) => one.slug === parentSlug)
    : undefined;
  return {
    title: titleOf(topic),
    domain: domainOfTopic(topics, slug),
    parent:
      parentSlug === undefined
        ? null
        : {
            slug: parentSlug,
            title: parent ? titleOf(parent) : parentSlug,
            domain: domainOfTopic(topics, parentSlug),
          },
  };
}
