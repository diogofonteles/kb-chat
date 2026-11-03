import type { TopicFolder, VaultReaderPort } from '../../ports/vault-reader.js';
import type { CollectionRegistry } from './collection-registry.js';

/**
 * The vault as the app sees it (ADR 0028): its topics plus the collections created on the
 * screen, whose names override the vault's. Documents still come only from the vault; a
 * collection the vault does not have yet simply has none.
 */
export class CollectionsVault implements VaultReaderPort {
  constructor(
    private readonly vault: VaultReaderPort,
    private readonly registry: CollectionRegistry,
  ) {}

  async listTopics(): Promise<readonly TopicFolder[]> {
    const [folders, collections] = await Promise.all([
      this.vault.listTopics(),
      this.registry.list(),
    ]);
    const bySlug = new Map(folders.map((folder) => [folder.slug, folder]));
    for (const { slug, title, description, parent } of collections) {
      const within = bySlug.get(slug)?.parent ?? parent;
      bySlug.set(
        slug,
        within
          ? { slug, title, description, parent: within }
          : { slug, title, description },
      );
    }
    return [...bySlug.values()].sort((a, b) => a.slug.localeCompare(b.slug));
  }

  /** A collection with no vault folder yet has no documents (the reader finds none). */
  listDocuments(topic: string): Promise<readonly string[]> {
    return this.vault.listDocuments(topic);
  }

  readDocument(topic: string, id: string): Promise<string | null> {
    return this.vault.readDocument(topic, id);
  }
}
