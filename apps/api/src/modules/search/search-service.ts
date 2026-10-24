import type {
  SearchRequest,
  SearchResponse,
  SearchHit,
} from '@kb-chat/contracts';
import { searchRequestSchema } from '@kb-chat/contracts';
import { AppError } from '../../app-error.js';
import type { IndexHit, SearchIndexPort } from '../../ports/search-index.js';
import type { VaultReaderPort } from '../../ports/vault-reader.js';
import {
  splitFrontmatter,
  type CatalogEntry,
  type CatalogRegistry,
  type TopicCatalog,
} from '../catalog/index.js';
import { cleanSnippet } from './snippet.js';

export interface SearchServiceDeps {
  readonly catalog: CatalogRegistry;
  readonly index: SearchIndexPort;
  readonly vault: VaultReaderPort;
}

/** QMD derives a collection name from the topic id. */
export const toCollection = (topic: string): string =>
  topic.replace(/\//g, '-');

export class SearchService {
  constructor(private readonly deps: SearchServiceDeps) {}

  async search(topic: string, request: SearchRequest): Promise<SearchResponse> {
    const catalog = this.requireTopic(topic);
    const { q, mode, limit } = searchRequestSchema.parse(request);
    const startedAt = performance.now();
    const hits = await this.queryIndex({
      collection: toCollection(topic),
      q,
      mode,
      limit,
    });
    const known = hits
      .filter((hit) => catalog.entries.has(hit.id))
      .slice(0, limit);
    const items = await Promise.all(
      known.map((hit) => this.toSearchHit(catalog, hit)),
    );
    return {
      items,
      total: items.length,
      mode,
      tookMs: Math.round(performance.now() - startedAt),
    };
  }

  private requireTopic(topic: string): TopicCatalog {
    const catalog = this.deps.catalog.get(topic);
    if (!catalog)
      throw new AppError('TOPIC_NOT_FOUND', `Unknown topic ${topic}`);
    return catalog;
  }

  private async queryIndex(
    query: Parameters<SearchIndexPort['search']>[0],
  ): Promise<readonly IndexHit[]> {
    try {
      return await this.deps.index.search(query);
    } catch (err) {
      throw new AppError('SEARCH_UNAVAILABLE', 'Search index unavailable', {
        cause: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private async toSearchHit(
    catalog: TopicCatalog,
    hit: IndexHit,
  ): Promise<SearchHit> {
    const entry = catalog.entries.get(hit.id) as CatalogEntry;
    const text = await this.deps.vault.readDocument(catalog.topic.slug, hit.id);
    const body = text === null ? '' : splitFrontmatter(text).body;
    return {
      id: entry.id,
      title: entry.title,
      snippet: cleanSnippet(hit.snippet, { body, summary: entry.summary }),
      score: hit.score,
      genre: entry.genre,
      depth: entry.depth,
      relevance: entry.relevance,
      concepts: [...entry.concepts],
    };
  }
}
