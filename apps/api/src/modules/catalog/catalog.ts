import type { TopicFolder, VaultReaderPort } from '../../ports/vault-reader.js';
import { toCatalogEntry, type CatalogEntry } from './catalog-entry.js';
import { RelationIndex } from './relations.js';
import { splitFrontmatter } from './frontmatter.js';
import { ScopeView } from './scope-view.js';

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
  /** One view per collection and load: a reload or a refresh makes new catalog objects. */
  private readonly views = new WeakMap<TopicCatalog, ScopeView>();
  private readonly listeners: (() => void)[] = [];

  constructor(private readonly vault: VaultReaderPort) {}

  /**
   * Told after every load or refresh: what the catalog sees changed (KBC-100 FR-6). A
   * listener that throws does not stop the others nor the load.
   */
  onReload(listener: () => void): void {
    this.listeners.push(listener);
  }

  private reloaded(): void {
    for (const listener of this.listeners) {
      try {
        listener();
      } catch {
        // A listener logs its own failures; the catalog stays loaded.
      }
    }
  }

  async load(): Promise<void> {
    const topics = await this.vault.listTopics();
    const loaded = await Promise.all(
      topics.map((topic) => loadTopicCatalog(this.vault, topic)),
    );
    this.catalogs = new Map(
      loaded.map((catalog) => [catalog.topic.slug, catalog]),
    );
    this.reloaded();
  }

  /**
   * Reads one collection again (created or renamed on the screen, KBC-048 FR-3) without
   * reloading the others; a slug the vault and the registry no longer have is dropped.
   */
  async refresh(slug: string): Promise<void> {
    const topic = (await this.vault.listTopics()).find(
      (one) => one.slug === slug,
    );
    const loaded = topic ? await loadTopicCatalog(this.vault, topic) : null;
    // Swapped after every await, so two refreshes at once never drop each other's topic.
    const next = new Map(this.catalogs);
    if (loaded) next.set(slug, loaded);
    else next.delete(slug);
    this.catalogs = next;
    this.reloaded();
  }

  topics(): readonly TopicCatalog[] {
    return [...this.catalogs.values()];
  }

  get(slug: string): TopicCatalog | undefined {
    return this.catalogs.get(slug);
  }

  /** A collection and its sub-collections (ADR 0028); empty when the slug is unknown. */
  scope(slug: string): readonly TopicCatalog[] {
    const catalog = this.catalogs.get(slug);
    if (!catalog) return [];
    const children = this.topics().filter((one) => one.topic.parent === slug);
    return [catalog, ...children];
  }

  /** The collection and its sub-collections as one set (KBC-101 FR-5); undefined when unknown. */
  scopeView(slug: string): ScopeView | undefined {
    const [root, ...children] = this.scope(slug);
    if (!root) return undefined;
    const known = this.views.get(root);
    const same =
      known?.children.length === children.length &&
      known.children.every((one, at) => one === children[at]);
    if (known && same) return known;
    const view = new ScopeView(root, children);
    this.views.set(root, view);
    return view;
  }

  documentCount(): number {
    return this.topics().reduce(
      (sum, catalog) => sum + catalog.entries.size,
      0,
    );
  }
}
