import type {
  SearchHit,
  SearchRequest,
  SearchResponse,
} from '@kb-chat/contracts';
import { searchRequestSchema } from '@kb-chat/contracts';
import { AppError } from '../../app-error.js';
import type {
  IndexHit,
  IndexQuery,
  SearchIndexPort,
} from '../../ports/search-index.js';
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

/** Candidates asked from the index so `total` counts more than one page. */
export const MAX_CANDIDATES = 50;

/** QMD derives a collection name from the topic id. */
export const toCollection = (topic: string): string =>
  topic.replace(/\//g, '-');

/**
 * A line break in the question would be read by QMD as a structured query
 * document ("lex:", "vec:" lines), so all whitespace collapses to one space.
 */
export const normalizeQuestion = (q: string): string =>
  q.replace(/\s+/g, ' ').trim();

interface KnownHit {
  readonly hit: IndexHit;
  readonly entry: CatalogEntry;
}

export class SearchService {
  constructor(private readonly deps: SearchServiceDeps) {}

  async search(topic: string, request: SearchRequest): Promise<SearchResponse> {
    const catalog = this.requireTopic(topic);
    const { q, mode, limit } = searchRequestSchema.parse(request);
    const startedAt = performance.now();
    const hits = await this.queryIndex({
      collection: toCollection(topic),
      q: normalizeQuestion(q),
      mode,
      limit: MAX_CANDIDATES,
    });
    const known = this.keepCataloged(catalog, hits);
    const items = await Promise.all(
      known.slice(0, limit).map((found) => this.toSearchHit(catalog, found)),
    );
    return {
      items,
      total: known.length,
      capped: hits.length >= MAX_CANDIDATES,
      mode,
      tookMs: Math.round(performance.now() - startedAt),
    };
  }

  private keepCataloged(
    catalog: TopicCatalog,
    hits: readonly IndexHit[],
  ): KnownHit[] {
    const known: KnownHit[] = [];
    for (const hit of hits) {
      const entry = catalog.entries.get(hit.id);
      if (entry) known.push({ hit, entry });
    }
    return known;
  }

  private requireTopic(topic: string): TopicCatalog {
    const catalog = this.deps.catalog.get(topic);
    if (!catalog)
      throw new AppError('TOPIC_NOT_FOUND', `Unknown topic ${topic}`);
    return catalog;
  }

  private async queryIndex(query: IndexQuery): Promise<readonly IndexHit[]> {
    try {
      return await this.deps.index.search(query);
    } catch (err) {
      throw new AppError('SEARCH_UNAVAILABLE', 'Search index unavailable', {
        cause: err,
      });
    }
  }

  private async toSearchHit(
    catalog: TopicCatalog,
    { hit, entry }: KnownHit,
  ): Promise<SearchHit> {
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
