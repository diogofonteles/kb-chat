import { authorSlugOf, type Author } from '@kb-chat/contracts';

/** At most this many suggestions, so the list is scanned at a glance (SL-11). */
export const MAX_SUGGESTIONS = 8;

/** What the field offers for the text typed. */
export interface Suggestions {
  readonly authors: readonly Author[];
  /** "Cadastrar «nome»": the text is a name the list does not have. */
  readonly register: string | null;
}

const fold = (text: string): string =>
  text
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();

/**
 * The authors whose name contains the text (accents and case aside), the main one first,
 * then those that start with it; and the offer to register the text when it is no author.
 */
export function suggestAuthors(
  authors: readonly Author[],
  text: string,
): Suggestions {
  const query = fold(text);
  const slug = authorSlugOf(text);
  const matching = query
    ? authors.filter((author) => fold(author.name).includes(query))
    : authors;
  const rank = (author: Author): number =>
    author.main ? 0 : fold(author.name).startsWith(query) ? 1 : 2;
  const sorted = [...matching].sort((a, b) => rank(a) - rank(b));
  const known = authors.some((author) => author.slug === slug);
  return {
    authors: sorted.slice(0, MAX_SUGGESTIONS),
    register: slug && !known ? text.trim() : null,
  };
}
