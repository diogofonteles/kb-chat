import type { CatalogEntry, CatalogRegistry } from '../catalog/index.js';
import type { AuthorDirectory } from './author-directory.js';
import type { AuthorsService } from './authors-service.js';

/** The authorship the app had before KBC-049 (ADR 0015): its id and name. */
export const LEGACY_MAIN_AUTHOR = {
  slug: 'mestre-laercio',
  name: 'Mestre Laércio',
  fullName: 'José Laércio do Egito',
  aliases: ['o Mestre', 'Laércio'],
};

export interface LegacySeedDeps {
  readonly directory: AuthorDirectory;
  readonly authors: AuthorsService;
  readonly catalog: Pick<CatalogRegistry, 'topics'>;
  /** The collections holding media by the legacy main author (after the media migration). */
  readonly mediaTopicsOfLegacyAuthor?: () => readonly string[];
}

const hasLegacyDocument = (entries: Iterable<CatalogEntry>): boolean => {
  for (const entry of entries)
    if (entry.authorship === LEGACY_MAIN_AUTHOR.slug) return true;
  return false;
};

/**
 * BR-4 (AC-5): a top-level collection that the authors file does not know yet and that has
 * documents marked `mestre-laercio` or media by him gets "Mestre Laércio" as its main
 * author, so the Hermetismo shows "✦ Mestre Laércio" as before. A collection already in the
 * file is never touched, so clearing or changing the main author sticks.
 */
export async function seedLegacyAuthors(
  deps: LegacySeedDeps,
  now: Date = new Date(),
): Promise<readonly string[]> {
  const roots = new Set<string>();
  for (const { topic, entries } of deps.catalog.topics())
    if (hasLegacyDocument(entries.values()))
      roots.add(deps.authors.rootOf(topic.slug));
  for (const topic of deps.mediaTopicsOfLegacyAuthor?.() ?? [])
    roots.add(deps.authors.rootOf(topic));
  const seeded: string[] = [];
  for (const root of [...roots].sort()) {
    const wrote = await deps.directory.seed(root, {
      main: LEGACY_MAIN_AUTHOR.slug,
      authors: [
        {
          ...LEGACY_MAIN_AUTHOR,
          createdBy: 'migration',
          createdAt: now.toISOString(),
        },
      ],
    });
    if (wrote) seeded.push(root);
  }
  return seeded;
}
