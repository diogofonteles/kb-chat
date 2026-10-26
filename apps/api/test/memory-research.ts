import type {
  IndexHit,
  IndexQuery,
  SearchIndexPort,
} from '../src/ports/search-index.js';
import type {
  TopicFolder,
  VaultReaderPort,
} from '../src/ports/vault-reader.js';
import { CatalogRegistry } from '../src/modules/catalog/index.js';
import { ResearchTools } from '../src/modules/research/index.js';
import { SearchService } from '../src/modules/search/index.js';

/** An in-memory vault with one topic, "hermetismo"; it counts reads. */
export class MemoryVault implements VaultReaderPort {
  reads = 0;

  constructor(public docs: Record<string, string>) {}

  async listTopics(): Promise<readonly TopicFolder[]> {
    return [{ slug: 'hermetismo', title: 'Hermetismo' }];
  }

  async listDocuments(): Promise<readonly string[]> {
    return Object.keys(this.docs);
  }

  async readDocument(_topic: string, id: string): Promise<string | null> {
    this.reads += 1;
    return this.docs[id] ?? null;
  }
}

/** An index that returns the given hits for every query (the meaning search, faked). */
export class FixedIndex implements SearchIndexPort {
  readonly queries: IndexQuery[] = [];

  constructor(private readonly hits: readonly IndexHit[] = []) {}

  async search(query: IndexQuery): Promise<readonly IndexHit[]> {
    this.queries.push(query);
    return this.hits.slice(0, query.limit);
  }

  status(): 'ok' {
    return 'ok';
  }

  async close(): Promise<void> {
    return undefined;
  }
}

export interface MemoryDoc {
  readonly title: string;
  readonly body: string;
  readonly summary?: string;
  readonly entities?: readonly string[];
  readonly sourcePath?: string;
  /** The owner-managed `author_group` key (KBC-020); absent = not classified. */
  readonly authorGroup?: string;
  readonly author?: string;
}

/** A raw document's markdown with kb-like frontmatter. */
export function memoryDoc(doc: MemoryDoc): string {
  const lines = [
    '---',
    `title: ${doc.title}`,
    `summary: ${doc.summary ?? 'Um texto.'}`,
    ...(doc.sourcePath ? [`source_path: ${doc.sourcePath}`] : []),
    ...(doc.authorGroup ? [`author_group: ${doc.authorGroup}`] : []),
    ...(doc.author ? [`author: ${doc.author}`] : []),
    ...(doc.entities && doc.entities.length > 0
      ? ['entities:', ...doc.entities.map((name) => `    - ${name}`)]
      : []),
    '---',
    '',
    doc.body,
    '',
  ];
  return lines.join('\n');
}

/** The research tools over an in-memory vault and a fixed index. */
export async function memoryTools(
  vault: MemoryVault,
  index: SearchIndexPort = new FixedIndex(),
): Promise<ResearchTools> {
  const catalog = new CatalogRegistry(vault);
  await catalog.load();
  const search = new SearchService({ catalog, index, vault });
  return new ResearchTools({ search, catalog, vault });
}
