import {
  MAX_MEDIA_HITS,
  MEDIA_COUNT_CAP,
  searchRequestSchema,
  type Authorship,
  type KindCounts,
  type MediaHit,
  type SearchKind,
  type SearchRequest,
  type SearchResponse,
} from '@kb-chat/contracts';
import type {
  AuthorRule,
  AuthorshipTally,
  MediaSearchPort,
} from '../../ports/media-search.js';
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
  readonly documents: Pick<SearchService, 'search'>;
  /** The collection and its sub-collections, by the catalog's tree (ADR 0028). */
  readonly scopeOf: (topic: string) => readonly string[];
  /** Absent when the media library is off (KB_CHAT_MEDIA=off). */
  readonly media?: MediaSearchPort;
  readonly authors: AuthorView;
}

type ParsedRequest = ReturnType<typeof searchRequestSchema.parse>;

interface SpokenPart {
  readonly hits: readonly MediaHit[];
  /** null: the collection has no audio this person may hear. */
  readonly count: number | null;
  /** Matches per "Autoria" group, whatever group is chosen (a disjunctive facet). */
  readonly byAuthorship?: AuthorshipTally;
}

const NO_AUDIO: SpokenPart = { hits: [], count: null };

/** The passages' total under the "Autoria" choice, from the tally (up to the cap). */
const totalUnder = (rule: AuthorRule, tally: AuthorshipTally): number => {
  if (rule.kind === 'main') return tally.main;
  if (rule.kind === 'others') return tally.others;
  return Math.min(tally.main + tally.others, MEDIA_COUNT_CAP);
};

/**
 * The kinds that really search (BR-4): the chosen ones this collection has for this
 * person, and the texts when none of them is left (a remembered "Áudios" only, in a
 * collection without audio or for someone who may not listen, never empties the search).
 */
export function effectiveKinds(
  chosen: readonly SearchKind[],
  available: KindCounts,
): readonly SearchKind[] {
  const reach = chosen.filter((kind) => available[kind] !== null);
  return reach.length > 0 ? reach : ['text'];
}

/** The "Autoria" counts with the passages' added (the facet covers both kinds). */
function withSpokenAuthorships(
  facets: SearchResponse['facets'],
  spoken: SpokenPart['byAuthorship'],
): SearchResponse['facets'] {
  if (!spoken) return facets;
  const added: Partial<Record<Authorship, number>> = {
    'mestre-laercio': spoken.main,
    'outros-autores': spoken.others,
  };
  const known = new Set(facets.authorships.map((one) => one.value));
  const merged = facets.authorships.map((one) => ({
    value: one.value,
    count: one.count + (added[one.value] ?? 0),
  }));
  for (const [value, count] of Object.entries(added) as [Authorship, number][])
    if (!known.has(value) && count > 0) merged.push({ value, count });
  return { ...facets, authorships: merged };
}

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
    const reach = effectiveKinds(parsed.kinds, kinds);
    const texts = reach.includes('text')
      ? documents
      : {
          ...documents,
          items: [],
          total: 0,
          nextOffset: null,
          hiddenOffTopic: 0,
        };
    const audio = reach.includes('audio');
    const media = audio && parsed.offset === 0 ? spoken.hits : [];
    const facets = audio
      ? withSpokenAuthorships(texts.facets, spoken.byAuthorship)
      : texts.facets;
    return { ...texts, facets, media: [...media], kinds };
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
    const { media } = this.deps;
    if (!media || !viewer.mayHear) return NO_AUDIO;
    const visible = this.visibleScope(topic, viewer);
    if (!media.hasTranscripts(visible)) return NO_AUDIO;
    if (hasDocumentOnlyFilters(filters)) return { hits: [], count: 0 };
    const topics =
      filters.topics.length > 0
        ? visible.filter((slug) => filters.topics.includes(slug))
        : visible;
    return this.passagesIn(media, { terms: termsOf(q), topics, filters });
  }

  /** The passages under the "Autoria" choice, and the count of each group. */
  private passagesIn(
    media: MediaSearchPort,
    input: {
      readonly terms: readonly string[];
      readonly topics: readonly string[];
      readonly filters: ParsedRequest['filters'];
    },
  ): SpokenPart {
    const { terms, topics, filters } = input;
    const { authors } = this.deps;
    const mainOf = new Map(topics.map((slug) => [slug, authors.mainOf(slug)]));
    const byAuthorship = media.tally({ terms, topics, mainOf });
    const rule = authorRuleOf(filters.authorships, mainOf);
    if (rule === null) return { hits: [], count: 0, byAuthorship };
    const found = media.search({
      terms,
      topics,
      authors: rule,
      limit: MAX_MEDIA_HITS,
      count: false,
    });
    return {
      hits: found.matches.map((match) => toMediaHit(match, authors)),
      count: totalUnder(rule, byAuthorship),
      byAuthorship,
    };
  }

  /** The collection and its sub-collections the person sees (ADR 0028 §5). */
  private visibleScope(topic: string, viewer: SearchViewer): string[] {
    return this.deps.scopeOf(topic).filter((slug) => viewer.canSee(slug));
  }
}
