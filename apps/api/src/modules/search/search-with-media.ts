import {
  MAX_MEDIA_HITS,
  searchRequestSchema,
  type KindCounts,
  type MediaHit,
  type SearchRequest,
  type SearchResponse,
} from '@kb-chat/contracts';
import type { MediaSearchPort } from '../../ports/media-search.js';
import type { CatalogRegistry } from '../catalog/index.js';
import {
  authorRuleOf,
  hasDocumentOnlyFilters,
  termsOf,
  toMediaHit,
  type AuthorView,
} from './media-hits.js';
import type { SearchService } from './search-service.js';

/** Who searches, as the spoken passages need it (BR-1 and the per-person feature). */
export interface SearchViewer {
  /** The person holds "Ouvir mídia" (`media`): passages are listening. */
  readonly mayHear: boolean;
  /** The collection is one the person sees (ADR 0028 tree). */
  readonly canSee: (topic: string) => boolean;
}

/** Who asks, and where the media side's timing goes. */
export interface SearchContext {
  readonly viewer: SearchViewer;
  readonly report?: (entry: MediaReport) => void;
}

/** What happened on the media side of one search, for the request's log (ADR 0024). */
export interface MediaReport {
  readonly mediaMs: number;
  readonly mediaHits: number;
  readonly mediaError?: unknown;
}

export interface SearchWithMediaDeps {
  readonly documents: SearchService;
  readonly catalog: CatalogRegistry;
  /** Absent when the media library is off (KB_CHAT_MEDIA=off). */
  readonly media?: MediaSearchPort;
  readonly authors: AuthorView;
}

type ParsedRequest = ReturnType<typeof searchRequestSchema.parse>;

interface SpokenPart {
  readonly hits: readonly MediaHit[];
  /** null: the collection has no audio this person may hear. */
  readonly count: number | null;
}

const NO_AUDIO: SpokenPart = { hits: [], count: null };

/**
 * The free search over texts and spoken passages (KBC-039, ADR 0024 §2): the vault's
 * index as before and, beside it, the transcripts' own index; both always run so each
 * kind has its count, and `kinds` chooses what comes back.
 */
export class SearchWithMedia {
  constructor(private readonly deps: SearchWithMediaDeps) {}

  async search(
    topic: string,
    request: SearchRequest,
    context: SearchContext,
  ): Promise<SearchResponse> {
    const parsed = searchRequestSchema.parse(request);
    // The vault's index answers over IO while the media index (synchronous SQLite) runs.
    const pending = this.deps.documents.search(topic, parsed);
    const spoken = this.spoken(topic, parsed, context);
    const documents = await pending;
    const kinds: KindCounts = { text: documents.total, audio: spoken.count };
    const texts = parsed.kinds.includes('text')
      ? documents
      : {
          ...documents,
          items: [],
          total: 0,
          nextOffset: null,
          hiddenOffTopic: 0,
        };
    const media =
      parsed.kinds.includes('audio') && parsed.offset === 0 ? spoken.hits : [];
    return { ...texts, media: [...media], kinds };
  }

  /** The passages, timed and never failing the search: a broken index means texts only. */
  private spoken(
    topic: string,
    request: ParsedRequest,
    { viewer, report = () => undefined }: SearchContext,
  ): SpokenPart {
    const startedAt = performance.now();
    const elapsed = () => Math.round(performance.now() - startedAt);
    try {
      const part = this.findSpoken(topic, request, viewer);
      report({ mediaMs: elapsed(), mediaHits: part.hits.length });
      return part;
    } catch (err) {
      report({ mediaMs: elapsed(), mediaHits: 0, mediaError: err });
      return NO_AUDIO;
    }
  }

  private findSpoken(
    topic: string,
    { q, filters }: ParsedRequest,
    viewer: SearchViewer,
  ): SpokenPart {
    const { media, authors } = this.deps;
    if (!media || !viewer.mayHear) return NO_AUDIO;
    const visible = this.visibleScope(topic, viewer);
    if (!media.hasTranscripts(visible)) return NO_AUDIO;
    const topics =
      filters.topics.length > 0
        ? visible.filter((slug) => filters.topics.includes(slug))
        : visible;
    const mainOf = new Map(topics.map((slug) => [slug, authors.mainOf(slug)]));
    const rule = authorRuleOf(filters.authorships, mainOf);
    if (rule === null || hasDocumentOnlyFilters(filters))
      return { hits: [], count: 0 };
    const found = media.search({
      terms: termsOf(q),
      topics,
      authors: rule,
      limit: MAX_MEDIA_HITS,
    });
    return {
      hits: found.matches.map((match) => toMediaHit(match, authors)),
      count: found.total,
    };
  }

  /** The collection and its sub-collections the person sees (ADR 0028 §5). */
  private visibleScope(topic: string, viewer: SearchViewer): string[] {
    return this.deps.catalog
      .scope(topic)
      .map((one) => one.topic.slug)
      .filter((slug) => viewer.canSee(slug));
  }
}
