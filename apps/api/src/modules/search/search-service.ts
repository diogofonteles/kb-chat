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

interface FoundGroups {
  readonly groups: readonly CopyGroup[];
  readonly capped: boolean;
}

/**
 * One collection keeps its index order; several (a parent and its sub-collections) are
 * interleaved by score, each group keeping its own collection.
 */
function mergeByScore(found: readonly FoundGroups[]): CopyGroup[] {
  if (found.length === 1) return [...(found[0]?.groups ?? [])];
  return found
    .flatMap((one) => one.groups)
    .sort((a, b) => b.lead.hit.score - a.lead.hit.score);
}

export class SearchService {
  /** Which collection each group of the current searches came from. */
  private readonly topicOf = new WeakMap<CopyGroup, TopicCatalog>();

  constructor(private readonly deps: SearchServiceDeps) {}

  async search(topic: string, request: SearchRequest): Promise<SearchResponse> {
    const scope = this.requireScope(topic);
    const { q, mode, limit, offset, filters } =
      searchRequestSchema.parse(request);
    const startedAt = performance.now();
    const found = await Promise.all(
      scope.map((catalog) => this.findGroups(catalog, { q, mode, filters })),
    );
    const { page, ...refined } = refine(mergeByScore(found), {
      filters,
      offset,
      limit,
      maxResults: MAX_RESULTS,
    });
    const items = await Promise.all(
      page.map((group) => this.toSearchHit(group)),
    );
    return {
      ...refined,
      items,
      capped: found.some((one) => one.capped),
      // Texts only: SearchWithMedia adds the spoken passages (KBC-039).
      media: [],
      kinds: { text: refined.total, audio: null },
      mode,
      tookMs: Math.round(performance.now() - startedAt),
    };
  }

  /**
   * Index candidates for the question, kept when cataloged and grouped by copy. A collection
   * with no documents (created on the screen, ADR 0028) has no index collection to ask.
   */
  private async findGroups(
    catalog: TopicCatalog,
    { q, mode, filters }: Pick<SearchFilterQuery, 'q' | 'mode' | 'filters'>,
  ): Promise<FoundGroups> {
    if (catalog.entries.size === 0) return { groups: [], capped: false };
    const filtered = Object.values(filters).some((values) => values.length > 0);
    const limit = filtered ? CANDIDATES.filtered : CANDIDATES.plain;
    const collection = toCollection(catalog.topic.slug);
    const hits = await this.queryIndex({
      collection,
      q: normalizeQuestion(q),
      mode,
      limit,
    });
    const groups = groupCopies(this.keepCataloged(catalog, hits));
    for (const group of groups) this.topicOf.set(group, catalog);
    return { groups, capped: hits.length >= limit };
  }

  /** Collection-wide counts per facet value (start-screen suggestions and "no acervo" counts). */
  topicFacets(topic: string): TopicFacets {
    const entries = this.requireScope(topic).flatMap((catalog) =>
      [...catalog.entries.values()].map((entry) => ({
        ...entry,
        topic: catalog.topic.slug,
      })),
    );
    return countFacets(() => entries);
  }

  private keepCataloged(
    catalog: TopicCatalog,
    hits: readonly IndexHit[],
  ): Candidate[] {
    const known: Candidate[] = [];
    const topic = catalog.topic.slug;
    for (const hit of hits) {
      const entry = catalog.entries.get(hit.id);
      // The collection rides along for the "Sub-acervo" filter (KBC-048 FR-4).
      if (entry) known.push({ hit, entry: { ...entry, topic } });
    }
    return known;
  }

  /** The collection and its sub-collections: a parent searches like a folder (ADR 0028). */
  private requireScope(topic: string): readonly TopicCatalog[] {
    const scope = this.deps.catalog.scope(topic);
    if (scope.length === 0)
      throw new AppError('TOPIC_NOT_FOUND', `Unknown topic ${topic}`);
    return scope;
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

  private async toSearchHit(group: CopyGroup): Promise<SearchHit> {
    const { lead, copies } = group;
    const { hit, entry } = lead;
    const catalog = this.topicOf.get(group);
    if (!catalog) throw new Error('search group without its collection');
    const text = await this.deps.vault.readDocument(catalog.topic.slug, hit.id);
    const body = text === null ? '' : splitFrontmatter(text).body;
    return {
      topic: catalog.topic.slug,
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
