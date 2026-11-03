import { topicSlugSchema } from '@kb-chat/contracts';
import { z } from 'zod';
import { AppError } from '../../app-error.js';
import type { DocumentStorePort } from '../../ports/document-store.js';
import { SerialDocument } from '../../serial-document.js';

const storedCollectionSchema = z
  .strictObject({
    slug: topicSlugSchema,
    title: z.string(),
    description: z.string(),
    parent: topicSlugSchema.nullable(),
    /** Who created it on the screen; absent for a vault topic renamed on the screen. */
    createdBy: z.string().optional(),
    createdAt: z.string().optional(),
  })
  // One level only (BR-2): a sub-collection's slug is its parent's plus one segment. A
  // vault topic renamed here keeps the vault's slug, grouping folder included.
  .refine((one) =>
    one.parent === null
      ? one.createdBy === undefined || !one.slug.includes('/')
      : one.slug.startsWith(`${one.parent}/`) &&
        !one.slug.slice(one.parent.length + 1).includes('/'),
  );
export type StoredCollection = z.infer<typeof storedCollectionSchema>;

const registrySchema = z.strictObject({
  version: z.literal(1),
  collections: z.array(storedCollectionSchema),
});
type Registry = z.infer<typeof registrySchema>;

export interface NewCollection {
  readonly slug: string;
  readonly title: string;
  readonly description: string;
  readonly parent: string | null;
  readonly createdBy: string;
  readonly createdAt: string;
}

export interface CollectionNames {
  readonly title?: string;
  readonly description?: string;
}

/**
 * The collections created or renamed on the screen (`collections.json` in the state dir,
 * ADR 0028); the vault itself is never written (Q7).
 */
export class CollectionRegistry {
  private readonly doc: SerialDocument<Registry>;

  constructor(store: DocumentStorePort) {
    this.doc = new SerialDocument<Registry>({
      store,
      parse: (raw) => {
        const parsed = registrySchema.safeParse(raw);
        if (!parsed.success)
          throw new AppError('INTERNAL', 'collections.json is invalid');
        return parsed.data;
      },
      empty: () => ({ version: 1, collections: [] }),
    });
  }

  async list(): Promise<readonly StoredCollection[]> {
    return (await this.doc.read()).collections;
  }

  /** Refuses a slug already taken here or, per `taken`, in the vault (KBC-048 NFR-2). */
  create(
    collection: NewCollection,
    taken: (slug: string) => boolean,
  ): Promise<StoredCollection> {
    return this.doc.change((doc) => {
      const exists =
        taken(collection.slug) ||
        doc.collections.some((one) => one.slug === collection.slug);
      if (exists)
        throw new AppError('TOPIC_EXISTS', `Topic ${collection.slug} exists`);
      const stored: StoredCollection = { ...collection };
      return {
        doc: { ...doc, collections: [...doc.collections, stored] },
        result: stored,
      };
    });
  }

  /** Undoes a creation whose next step failed (KBC-048 NFR-2: nothing half made). */
  remove(slug: string): Promise<void> {
    return this.doc.change((doc) => ({
      doc: {
        ...doc,
        collections: doc.collections.filter((one) => one.slug !== slug),
      },
      result: undefined,
    }));
  }

  /**
   * New names for a collection; a vault topic gets an entry that only overrides its names
   * (`base` is what the vault says), so renaming never touches the vault (BR-4).
   */
  rename(
    base: Pick<StoredCollection, 'slug' | 'title' | 'description' | 'parent'>,
    names: CollectionNames,
  ): Promise<StoredCollection> {
    return this.doc.change((doc) => {
      const current =
        doc.collections.find((one) => one.slug === base.slug) ?? base;
      const next: StoredCollection = {
        ...current,
        title: names.title ?? current.title,
        description: names.description ?? current.description,
      };
      const others = doc.collections.filter((one) => one.slug !== base.slug);
      return {
        doc: { ...doc, collections: [...others, next] },
        result: next,
      };
    });
  }
}
