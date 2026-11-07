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
  isTrackEntry,
  splitFrontmatter,
  type CatalogEntry,
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

/**
 * Which cataloged documents a search may return. The documents search (T2), its counts and
 * suggestions take texts only (ADR 0035 §8); the research tools admit the tracks the person
 * may research (KBC-099 BR-4).
 */
export interface SearchScope {
  readonly admit?: (entry: CatalogEntry) => boolean;
}

const textsOnly = (entry: CatalogEntry): boolean => !isTrackEntry(entry);

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
  /** Track documents per catalog load: the index ranks them among the texts. */
  private readonly trackCounts = new WeakMap<TopicCatalog, number>();

  constructor(private readonly deps: SearchServiceDeps) {}

  async search(
    topic: string,
    request: SearchRequest,
    { admit = textsOnly }: SearchScope = {},
  ): Promise<SearchResponse> {
    const { q, mode, limit, offset, filters } =
      searchRequestSchema.parse(request);
    const startedAt = performance.now();
    const found = await this.foundIn(topic, { q, mode, filters, admit });
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

  /** Each collection of the scope searched at once (a parent and its sub-collections). */
  private foundIn(
    topic: string,
    query: Parameters<SearchService['findGroups']>[1],
  ): Promise<FoundGroups[]> {
    return Promise.all(
      this.requireScope(topic).map((one) => this.findGroups(one, query)),
    );
  }

  /**
   * Index candidates for the question, kept when cataloged and grouped by copy. A collection
   * with no documents (created on the screen, ADR 0028) has no index collection to ask.
   */
  private async findGroups(
    catalog: TopicCatalog,
    {
      q,
      mode,
      filters,
      admit,
    }: Pick<SearchFilterQuery, 'q' | 'mode' | 'filters'> & {
      admit: (entry: CatalogEntry) => boolean;
    },
  ): Promise<FoundGroups> {
    if (catalog.entries.size === 0) return { groups: [], capped: false };
    const filtered = Object.values(filters).some((values) => values.length > 0);
    const base = filtered ? CANDIDATES.filtered : CANDIDATES.plain;
    const hits = await this.textsAndTracks(catalog, {
      // A subject alone (KBC-070): the documents are found by its name.
      q: normalizeQuestion(q) || normalizeQuestion(filters.concepts.join(' ')),
      mode,
      base,
    });
    const groups = groupCopies(
      this.keepCataloged(catalog, { hits: hits.kept, admit }),
    );
    for (const group of groups) this.topicOf.set(group, catalog);
    return { groups, capped: hits.texts >= base };
  }

  /**
   * The index's top `base` non-track hits, exactly as a vault without track documents would
   * give them, plus the track hits ranked among them (KBC-099 AC-13): the index is asked for
   * more until `base` texts came back, the index ran out, or every track was skipped. Track
   * documents may rank anywhere, so a fixed extra would let them push texts out at scale.
   */
  private async textsAndTracks(
    catalog: TopicCatalog,
    query: { q: string; mode: IndexQuery['mode']; base: number },
  ): Promise<{ kept: readonly IndexHit[]; texts: number }> {
    const tracks = this.tracksIn(catalog);
    const isTrack = (hit: IndexHit) => {
      const entry = catalog.entries.get(hit.id);
      return entry !== undefined && isTrackEntry(entry);
    };
    let extra = Math.min(tracks, query.base);
    for (;;) {
      const limit = query.base + extra;
      const hits = await this.queryIndex({
        collection: toCollection(catalog.topic.slug),
        q: query.q,
        mode: query.mode,
        limit,
      });
      const texts = hits.filter((hit) => !isTrack(hit)).length;
      if (hits.length < limit || extra >= tracks || texts >= query.base)
        return this.firstTexts(hits, { isTrack, base: query.base });
      extra = Math.min(tracks, extra * 4);
    }
  }

  private firstTexts(
    hits: readonly IndexHit[],
    { isTrack, base }: { isTrack: (hit: IndexHit) => boolean; base: number },
  ): { kept: readonly IndexHit[]; texts: number } {
    const kept: IndexHit[] = [];
    let texts = 0;
    for (const hit of hits) {
      if (isTrack(hit)) kept.push(hit);
      else if (texts < base) {
        kept.push(hit);
        texts += 1;
      }
    }
    return { kept, texts };
  }

  private tracksIn(catalog: TopicCatalog): number {
    const known = this.trackCounts.get(catalog);
    if (known !== undefined) return known;
    const count = [...catalog.entries.values()].filter(isTrackEntry).length;
    this.trackCounts.set(catalog, count);
    return count;
  }

  /** Collection-wide counts per facet value (start-screen suggestions and "no acervo" counts). */
  topicFacets(topic: string): TopicFacets {
    const entries = this.requireScope(topic).flatMap((catalog) =>
      [...catalog.entries.values()].filter(textsOnly).map((entry) => ({
        ...entry,
        topic: catalog.topic.slug,
      })),
    );
    return countFacets(() => entries);
  }

  private keepCataloged(
    catalog: TopicCatalog,
    {
      hits,
      admit,
    }: {
      hits: readonly IndexHit[];
      admit: (entry: CatalogEntry) => boolean;
    },
  ): Candidate[] {
    const known: Candidate[] = [];
    const topic = catalog.topic.slug;
    for (const hit of hits) {
      const entry = catalog.entries.get(hit.id);
      // The collection rides along for the "Sub-acervo" filter (KBC-048 FR-4).
      if (entry && admit(entry))
        known.push({ hit, entry: { ...entry, topic } });
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
