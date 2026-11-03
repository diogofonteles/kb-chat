import {
  authorCreateSchema,
  authorSlugOf,
  type Author,
  type AuthorCreate,
} from '@kb-chat/contracts';
import { AppError } from '../../app-error.js';
import type { CatalogRegistry } from '../catalog/index.js';
import type { AuthorDirectory, CollectionAuthors } from './author-directory.js';

export interface AuthorsServiceDeps {
  readonly directory: AuthorDirectory;
  readonly catalog: Pick<CatalogRegistry, 'get'>;
  readonly now?: () => Date;
}

/** The main author as a collection shows it. */
export interface MainAuthor {
  readonly slug: string;
  readonly name: string;
}

const collator = new Intl.Collator('pt-BR', { sensitivity: 'base' });

const toAuthors = ({ main, authors }: CollectionAuthors): Author[] =>
  authors
    .map(({ slug, name }) => ({ slug, name, main: slug === main }))
    .sort(
      (a, b) =>
        Number(b.main) - Number(a.main) || collator.compare(a.name, b.name),
    );

/**
 * The authors of a collection (KBC-049, ADR 0030): a sub-collection uses its parent's list
 * and main author, found by the catalog's tree, never by the slug's text (BR-1, ADR 0028).
 */
export class AuthorsService {
  constructor(private readonly deps: AuthorsServiceDeps) {}

  /** The top-level collection whose list this one uses. */
  rootOf(topic: string): string {
    const parent = this.deps.catalog.get(topic)?.topic.parent;
    return parent && this.deps.catalog.get(parent) ? parent : topic;
  }

  /** The main author first, then by name. */
  list(topic: string): Author[] {
    return toAuthors(this.collectionOf(topic));
  }

  /** One author of the collection, or null when it has no such id. */
  authorOf(topic: string, slug: string): Author | null {
    return this.list(topic).find((one) => one.slug === slug) ?? null;
  }

  mainOf(topic: string): MainAuthor | null {
    const main = this.list(topic).find((one) => one.main);
    return main ? { slug: main.slug, name: main.name } : null;
  }

  /** Registers a name, or returns the author it already is (same id: same author). */
  async add(
    topic: string,
    input: AuthorCreate,
    by: string,
  ): Promise<{ readonly author: Author; readonly created: boolean }> {
    const { name } = authorCreateSchema.parse(input);
    const slug = authorSlugOf(name);
    if (!slug)
      throw new AppError('VALIDATION_FAILED', 'The name needs a letter', {
        details: { field: 'name' },
      });
    const root = this.rootOf(topic);
    const { created } = await this.deps.directory.add(root, {
      slug,
      name,
      createdBy: by,
      createdAt: (this.deps.now?.() ?? new Date()).toISOString(),
    });
    const author = this.authorOf(root, slug);
    if (!author) throw new AppError('INTERNAL', 'The author was not kept');
    return { author, created };
  }

  /** Only a top-level collection chooses its main author; a sub-collection uses its parent's. */
  async setMain(topic: string, slug: string | null): Promise<void> {
    if (this.rootOf(topic) !== topic)
      throw new AppError(
        'VALIDATION_FAILED',
        "A sub-collection uses its parent's main author",
        { details: { field: 'mainAuthor' } },
      );
    await this.deps.directory.setMain(topic, slug);
  }

  private collectionOf(topic: string): CollectionAuthors {
    return this.deps.directory.of(this.rootOf(topic));
  }
}
