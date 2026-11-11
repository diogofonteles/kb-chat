import { authorSlugSchema } from '@kb-chat/contracts';
import { z } from 'zod';
import { AppError } from '../../app-error.js';
import type { DocumentStorePort } from '../../ports/document-store.js';
import { SerialDocument } from '../../serial-document.js';

const storedAuthorSchema = z.strictObject({
  slug: authorSlugSchema,
  name: z.string().min(1),
  /** How the AI's rule names the main author in full ("José Laércio do Egito"). */
  fullName: z.string().min(1).optional(),
  /** How readers call him ("o Mestre", "Laércio"): the rule's triggers. */
  aliases: z.array(z.string().min(1)).optional(),
  /** Who registered it (the master when acting as a person, ADR 0027). */
  createdBy: z.string(),
  createdAt: z.string(),
});
export type StoredAuthor = z.infer<typeof storedAuthorSchema>;

const collectionAuthorsSchema = z
  .strictObject({
    main: authorSlugSchema.nullable(),
    authors: z.array(storedAuthorSchema),
  })
  .refine(
    (one) =>
      one.main === null || one.authors.some(({ slug }) => slug === one.main),
  );
export type CollectionAuthors = z.infer<typeof collectionAuthorsSchema>;

const directorySchema = z.strictObject({
  version: z.literal(1),
  /** By top-level collection slug (a sub-collection uses its parent's, BR-1). */
  collections: z.record(z.string(), collectionAuthorsSchema),
});
type Directory = z.infer<typeof directorySchema>;

/** The most authors one collection keeps (NFR-1 measures 500). */
export const AUTHORS_PER_COLLECTION_MAX = 2_000;

/** The author kept for a name, and whether this call registered it. */
export interface AddedAuthor {
  readonly author: StoredAuthor;
  readonly created: boolean;
}

const EMPTY: CollectionAuthors = { main: null, authors: [] };

/**
 * The authors of every collection (`authors.json` in the state dir, ADR 0030): the vault is
 * never written (Q7). Reads come from memory, loaded once and kept in step with each write,
 * so the prompt and the media list resolve names without waiting.
 */
export class AuthorDirectory {
  private readonly doc: SerialDocument<Directory>;
  private snapshot: Directory = { version: 1, collections: {} };

  constructor(store: DocumentStorePort) {
    this.doc = new SerialDocument<Directory>({
      store,
      parse: (raw) => {
        const parsed = directorySchema.safeParse(raw);
        if (!parsed.success)
          throw new AppError('INTERNAL', 'authors.json is invalid');
        return parsed.data;
      },
      empty: () => ({ version: 1, collections: {} }),
    });
  }

  async load(): Promise<void> {
    this.snapshot = await this.doc.read();
  }

  /** A collection's authors and main author; empty when it has none yet. */
  of(root: string): CollectionAuthors {
    return this.snapshot.collections[root] ?? EMPTY;
  }

  /** Whether the collection was ever written (the legacy seed never overrides it). */
  has(root: string): boolean {
    return root in this.snapshot.collections;
  }

  /** Adds the author unless one with that id exists; tells which one it keeps. */
  add(root: string, author: StoredAuthor): Promise<AddedAuthor> {
    return this.changeCollection<AddedAuthor>(root, (current) => {
      const existing = current.authors.find(({ slug }) => slug === author.slug);
      if (existing)
        return { next: current, result: { author: existing, created: false } };
      if (current.authors.length >= AUTHORS_PER_COLLECTION_MAX)
        throw new AppError('VALIDATION_FAILED', 'Too many authors', {
          details: { field: 'name' },
        });
      return {
        next: { ...current, authors: [...current.authors, author] },
        result: { author, created: true },
      };
    });
  }

  /** The main author (one of its authors) or none. */
  setMain(root: string, slug: string | null): Promise<void> {
    return this.changeCollection(root, (current) => {
      if (slug !== null && !current.authors.some((one) => one.slug === slug))
        throw new AppError('VALIDATION_FAILED', 'Unknown author', {
          details: { field: 'mainAuthor' },
        });
      return { next: { ...current, main: slug }, result: undefined };
    });
  }

  /**
   * Writes a collection only when the file has none for it (the one-time legacy seed,
   * BR-4); returns whether it wrote.
   */
  seed(root: string, collection: CollectionAuthors): Promise<boolean> {
    return this.change((doc) =>
      root in doc.collections
        ? { doc, result: false }
        : {
            doc: {
              ...doc,
              collections: { ...doc.collections, [root]: collection },
            },
            result: true,
          },
    );
  }

  private changeCollection<R>(
    root: string,
    apply: (current: CollectionAuthors) => {
      readonly next: CollectionAuthors;
      readonly result: R;
    },
  ): Promise<R> {
    return this.change((doc) => {
      const current = doc.collections[root] ?? EMPTY;
      const { next, result } = apply(current);
      if (next === current) return { doc, result };
      return {
        doc: { ...doc, collections: { ...doc.collections, [root]: next } },
        result,
      };
    });
  }

  private async change<R>(
    apply: (doc: Directory) => { readonly doc: Directory; readonly result: R },
  ): Promise<R> {
    const written: { doc?: Directory } = {};
    const result = await this.doc.change((doc) => {
      const changed = apply(doc);
      written.doc = changed.doc;
      return changed;
    });
    // Only once the file holds it: a failed write leaves memory as the file is.
    if (written.doc) this.snapshot = written.doc;
    return result;
  }
}
