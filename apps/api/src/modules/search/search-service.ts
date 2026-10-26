import type {
  SearchHit,
  SearchRequest,
  SearchResponse,
  TopicFacets,
} from '@kb-chat/contracts';
import { MAX_RESULTS, searchRequestSchema } from '@kb-chat/contracts';
import type { z } from 'zod';
import { AppError } from '../../app-error.js';
import type {
  IndexHit,
  IndexQuery,
  SearchIndexPort,
} from '../../ports/search-index.js';
import type { VaultReaderPort } from '../../ports/vault-reader.js';
import {
  splitFrontmatter,
  type CatalogRegistry,
  type TopicCatalog,
} from '../catalog/index.js';
import {
  countFacets,
  groupCopies,
  refine,
  type Candidate,
  type CopyGroup,
} from './refine.js';
import { cleanSnippet } from './snippet.js';

export interface SearchServiceDeps {
  readonly catalog: CatalogRegistry;
  readonly index: SearchIndexPort;
  readonly vault: VaultReaderPort;
}

/** Index candidates: enough for 50 results, more when filters may discard many (ADR 0003). */
export const CANDIDATES = { plain: 60, filtered: 200 } as const;

/** QMD derives a collection name from the topic id. */
export const toCollection = (topic: string): string =>
  topic.replace(/\//g, '-');

/**
 * A line break in the question would be read by QMD as a structured query
 * document ("lex:", "vec:" lines), so all whitespace collapses to one space.
 */
export const normalizeQuestion = (q: string): string =>
  q.replace(/\s+/g, ' ').trim();

type SearchFilterQuery = z.output<typeof searchRequestSchema>;

export class SearchService {
  constructor(private readonly deps: SearchServiceDeps) {}

  async search(topic: string, request: SearchRequest): Promise<SearchResponse> {
    const catalog = this.requireTopic(topic);
    const { q, mode, limit, offset, filters } =
      searchRequestSchema.parse(request);
    const startedAt = performance.now();
    const { groups, capped } = await this.findGroups(catalog, {
      q,
      mode,
      filters,
    });
    const { page, ...refined } = refine(groups, {
      filters,
      offset,
      limit,
      maxResults: MAX_RESULTS,
    });
    const items = await Promise.all(
      page.map((group) => this.toSearchHit(catalog, group)),
    );
    return {
      ...refined,
      items,
      capped,
      mode,
      tookMs: Math.round(performance.now() - startedAt),
    };
  }

  /** Index candidates for the question, kept when cataloged and grouped by copy. */
  private async findGroups(
    catalog: TopicCatalog,
    { q, mode, filters }: Pick<SearchFilterQuery, 'q' | 'mode' | 'filters'>,
  ): Promise<{ groups: CopyGroup[]; capped: boolean }> {
    const filtered = Object.values(filters).some((values) => values.length > 0);
    const limit = filtered ? CANDIDATES.filtered : CANDIDATES.plain;
    const collection = toCollection(catalog.topic.slug);
    const hits = await this.queryIndex({
      collection,
      q: normalizeQuestion(q),
      mode,
      limit,
    });
    return {
      groups: groupCopies(this.keepCataloged(catalog, hits)),
      capped: hits.length >= limit,
    };
  }

  /** Collection-wide counts per facet value (start-screen suggestions and "no acervo" counts). */
  topicFacets(topic: string): TopicFacets {
    const entries = [...this.requireTopic(topic).entries.values()];
    return countFacets(() => entries);
  }

  private keepCataloged(
    catalog: TopicCatalog,
    hits: readonly IndexHit[],
  ): Candidate[] {
    const known: Candidate[] = [];
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
    { lead, copies }: CopyGroup,
  ): Promise<SearchHit> {
    const { hit, entry } = lead;
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
      authorship: entry.authorship,
      author: entry.author,
      copies: copies.map((copy) => ({ id: copy.id, title: copy.title })),
    };
  }
}
