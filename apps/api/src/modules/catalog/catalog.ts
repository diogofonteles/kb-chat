import type { TopicFolder, VaultReaderPort } from '../../ports/vault-reader.js';
import { toCatalogEntry, type CatalogEntry } from './catalog-entry.js';
import { RelationIndex } from './relations.js';
import { splitFrontmatter } from './frontmatter.js';

export interface TopicCatalog {
  readonly topic: TopicFolder;
  readonly entries: ReadonlyMap<string, CatalogEntry>;
  readonly relations: RelationIndex;
}

const READ_CONCURRENCY = 64;

async function mapInChunks<T, R>(
  items: readonly T[],
  map: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = [];
  for (let start = 0; start < items.length; start += READ_CONCURRENCY) {
    const chunk = items.slice(start, start + READ_CONCURRENCY);
    results.push(...(await Promise.all(chunk.map(map))));
  }
  return results;
}

async function loadTopicCatalog(
  vault: VaultReaderPort,
  topic: TopicFolder,
): Promise<TopicCatalog> {
  const ids = await vault.listDocuments(topic.slug);
  const entries = await mapInChunks(ids, async (id) => {
    const text = await vault.readDocument(topic.slug, id);
    return text === null
      ? null
      : toCatalogEntry(id, splitFrontmatter(text).data);
  });
  const byId = new Map<string, CatalogEntry>();
  for (const entry of entries) if (entry) byId.set(entry.id, entry);
  return { topic, entries: byId, relations: new RelationIndex(byId.values()) };
}

/** In-memory facet catalog of every topic in the vault, derived from frontmatter (ADR 0003). */
export class CatalogRegistry {
  private catalogs = new Map<string, TopicCatalog>();

  constructor(private readonly vault: VaultReaderPort) {}

  async load(): Promise<void> {
    const topics = await this.vault.listTopics();
    const loaded = await Promise.all(
      topics.map((topic) => loadTopicCatalog(this.vault, topic)),
    );
    this.catalogs = new Map(
      loaded.map((catalog) => [catalog.topic.slug, catalog]),
    );
  }

  topics(): readonly TopicCatalog[] {
    return [...this.catalogs.values()];
  }

  get(slug: string): TopicCatalog | undefined {
    return this.catalogs.get(slug);
  }

  documentCount(): number {
    return this.topics().reduce(
      (sum, catalog) => sum + catalog.entries.size,
      0,
    );
  }
}
