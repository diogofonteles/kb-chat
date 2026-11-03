import type { MediaItem } from '@kb-chat/contracts';

/** The "Autoria" filter's value for media with no author ("Outros autores"). */
export const NO_AUTHOR = '-';
/** Its value for every author ("Todos"). */
export const ANY_AUTHOR = '';

export interface AuthorFilterOption {
  readonly value: string;
  readonly label: string;
  readonly count: number;
}

const collator = new Intl.Collator('pt-BR', { sensitivity: 'base' });

interface AuthorCount {
  readonly name: string;
  readonly main: boolean;
  readonly count: number;
}

/** Each author of the list with how many items are theirs. */
function countAuthors(items: readonly MediaItem[]): Map<string, AuthorCount> {
  const authors = new Map<string, AuthorCount>();
  for (const { author } of items)
    if (author)
      authors.set(author.slug, {
        name: author.name,
        main: author.main,
        count: (authors.get(author.slug)?.count ?? 0) + 1,
      });
  return authors;
}

/**
 * The "Autoria" choices of a list (KBC-049 FR-4): the main author first, "(principal)", the others
 * by name, then "Outros autores" for the media with none; each with its count.
 */
export function authorFilterOptions(
  items: readonly MediaItem[],
): AuthorFilterOption[] {
  const named = [...countAuthors(items).entries()]
    .sort(
      ([, a], [, b]) =>
        Number(b.main) - Number(a.main) || collator.compare(a.name, b.name),
    )
    .map(([slug, { name, main, count }]) => ({
      value: slug,
      // A native option reads its symbols aloud: the text says it instead of ✦.
      label: main
        ? $localize`:@@media.authorFilter.main:${name}:name: (principal)`
        : name,
      count,
    }));
  const none = items.filter((item) => item.author === null).length;
  if (none === 0) return named;
  return [
    ...named,
    {
      value: NO_AUTHOR,
      label: $localize`:@@authorship.others:Outros autores`,
      count: none,
    },
  ];
}

/** Whether an item is by the chosen author ("" is every one). */
export const matchesAuthor = (item: MediaItem, chosen: string): boolean =>
  chosen === ANY_AUTHOR ||
  (chosen === NO_AUTHOR ? item.author === null : item.author?.slug === chosen);
