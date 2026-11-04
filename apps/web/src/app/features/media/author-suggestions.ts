import { HttpErrorResponse } from '@angular/common/http';
import {
  authorNameSchema,
  authorSlugOf,
  type Author,
} from '@kb-chat/contracts';

/**
 * Whether a typed name breaks the API's rule (the shared contract: one line, at most 60
 * characters, no quotes nor « »); a blank field is no author, not an error.
 */
export const isInvalidAuthorName = (text: string): boolean =>
  text.trim() !== '' && !authorNameSchema.safeParse(text).success;

/** The author's name was refused (400): told as an author problem, never as another's. */
export class AuthorRefused extends Error {
  constructor() {
    super('The author name was refused');
  }
}

/** Registering a name failed: a 400 is the name's fault, anything else stays as it is. */
export const authorFailureOf = (err: unknown): unknown =>
  err instanceof HttpErrorResponse && err.status === 400
    ? new AuthorRefused()
    : err;

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
  const registrable = slug && !known && !isInvalidAuthorName(text);
  return {
    authors: sorted.slice(0, MAX_SUGGESTIONS),
    register: registrable ? text.trim() : null,
  };
}

/** At most this many edits apart, a typed name is taken for a typo of an author's. */
const TYPO_EDITS = 2;
/** Shorter names are too easy to confuse to suggest one for the other. */
const TYPO_MIN_CHARS = 4;

/** Edits (insert, remove, replace) between two short texts. */
function editsBetween(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    const row = [i];
    for (let j = 1; j <= b.length; j += 1)
      row[j] = Math.min(
        (previous[j] ?? 0) + 1,
        (row[j - 1] ?? 0) + 1,
        (previous[j - 1] ?? 0) + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    previous = row;
  }
  return previous[b.length] ?? 0;
}

/**
 * An author the typed name is probably a typo of ("Mestre Gabriell" → "Mestre Gabriel"),
 * asked before a new author is registered for good (KBC-049 review, MA-27); null when the
 * name is an author already or nothing is that close.
 */
export function closeMatch(
  authors: readonly Author[],
  text: string,
): Author | null {
  const query = fold(text);
  if (query.length < TYPO_MIN_CHARS) return null;
  if (authors.some((author) => fold(author.name) === query)) return null;
  let best: { author: Author; edits: number } | null = null;
  for (const author of authors) {
    const name = fold(author.name);
    if (Math.abs(name.length - query.length) > TYPO_EDITS) continue;
    const edits = editsBetween(name, query);
    if (edits <= TYPO_EDITS && (!best || edits < best.edits))
      best = { author, edits };
  }
  return best?.author ?? null;
}
