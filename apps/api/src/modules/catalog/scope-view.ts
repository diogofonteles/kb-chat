import type { TopicCatalog } from './catalog.js';
import type { CatalogEntry } from './catalog-entry.js';

/** Where a document of a scope really is: its collection and its id there. */
export interface DocumentHome {
  readonly topic: string;
  readonly id: string;
}

/**
 * A collection and its sub-collections as one set of documents (ADR 0028, KBC-101 FR-5): a
 * sub-collection's document gets an id relative to the parent's folder (`<sub>/raw/x.md`,
 * the file's real path there, never one of the parent's own `raw/` or `wiki/` ids) and its
 * `home`. Reading `<parent>` + that id reads the same file. Where such an id is already one
 * of the parent's (a sub-collection named `raw` or `wiki`), the parent's document is kept.
 */
export class ScopeView {
  readonly entries: ReadonlyMap<string, CatalogEntry>;

  constructor(
    readonly root: TopicCatalog,
    readonly children: readonly TopicCatalog[],
  ) {
    const entries = new Map(root.entries);
    // A sub-collection named `raw` or `wiki` would name its documents like the parent's own:
    // the parent's document stays, never swapped for another one.
    const scoped = children
      .flatMap((child) => this.scopedOf(child))
      .filter((entry) => !root.entries.has(entry.id));
    for (const entry of scoped) entries.set(entry.id, entry);
    this.entries = entries;
  }

  /** A sub-collection's documents with their scope ids and homes. */
  private scopedOf(child: TopicCatalog): CatalogEntry[] {
    return [...child.entries.values()].map((entry) => {
      const id = this.idOf(child.topic.slug, entry.id);
      return { ...entry, id, home: { topic: child.topic.slug, id: entry.id } };
    });
  }

  get topic(): string {
    return this.root.topic.slug;
  }

  /** The scope's id of a document of `topic` (the root or one of its sub-collections). */
  idOf(topic: string, id: string): string {
    return topic === this.topic
      ? id
      : `${topic.slice(this.topic.length + 1)}/${id}`;
  }

  /** The collection and id behind a scope id; undefined when the scope has no such document. */
  homeOf(id: string): DocumentHome | undefined {
    const entry = this.entries.get(id);
    if (!entry) return undefined;
    return entry.home ?? { topic: this.topic, id };
  }

  /** The catalog a document of the scope belongs to. */
  catalogOf(entry: Pick<CatalogEntry, 'home'>): TopicCatalog {
    const topic = entry.home?.topic;
    return this.children.find((one) => one.topic.slug === topic) ?? this.root;
  }
}
