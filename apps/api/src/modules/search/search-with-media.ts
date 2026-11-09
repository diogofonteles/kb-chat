import {
  MAX_MEDIA_HITS,
  MEDIA_COUNT_CAP,
  searchRequestSchema,
  type Authorship,
  type KindCounts,
  type MediaHit,
  type ResultFacets,
  type SearchKind,
  type SearchRequest,
  type SearchResponse,
  type SubjectTracksPage,
  type TopicFacets,
} from '@kb-chat/contracts';
import type {
  AuthorRule,
  AuthorshipTally,
  MediaSearchPort,
  TrackLinksPort,
} from '../../ports/media-search.js';
import type { TrackShelf } from '../../ports/track-shelf.js';
import {
  authorRuleOf,
  hasDocumentOnlyFilters,
  termsOf,
  toMediaHit,
  type AuthorView,
} from './media-hits.js';
import type { SearchService } from './search-service.js';
import { withSpokenPassages } from './track-passages.js';
import {
  withTrackCounts,
  type SubjectPage,
  type SubjectQuery,
  type SubjectSearch,
} from './subject-search.js';

/** Who searches, as the spoken passages need it (BR-1 and the per-person feature). */
export interface SearchViewer {
  /** The person holds "Ouvir mídia" (`media`): passages are listening. */
  readonly mayHear: boolean;
  /** Has `media-tracks`: passages inside a track answer as the track (KBC-068 BR-6). */
  readonly seesTracks?: boolean;
  /** Has `media-subjects` as well: subjects reach the search (KBC-070 BR-3). */
  readonly seesSubjects?: boolean;
  /** The collection is one the person sees (ADR 0028 tree). */
  readonly canSee: (topic: string) => boolean;
  /**
   * The track documents this person may see (KBC-101 BR-7): built for who has `media` and
   * `media-tracks`; absent, the documents search lists texts only.
   */
  readonly tracks?: TrackShelf;
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
  readonly documents: Pick<SearchService, 'searchDocuments' | 'topicFacets'>;
  /** Each track's best passage, for its card (KBC-101 BR-8); absent with the media library. */
  readonly passages?: Pick<TrackLinksPort, 'bestPassages'>;
  /** The collection and its sub-collections, by the catalog's tree (ADR 0028). */
  readonly scopeOf: (topic: string) => readonly string[];
  /** Absent when the media library is off (KB_CHAT_MEDIA=off). */
  readonly media?: MediaSearchPort;
  /** Tracks by subject (KBC-070); absent with the media library. */
  readonly subjects?: SubjectSearch;
  readonly authors: AuthorView;
}

type ParsedRequest = ReturnType<typeof searchRequestSchema.parse>;

interface SpokenPart {
  readonly hits: readonly MediaHit[];
  /** null: the collection has no audio this person may hear. */
  readonly count: number | null;
  /** Matches per "Autoria" group, whatever group is chosen (a disjunctive facet). */
  readonly byAuthorship?: AuthorshipTally;
  /** Tracks per subject, for who sees subjects (KBC-070 BR-4). */
  readonly tracksPerConcept?: ResultFacets['concepts'];
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

/** The passages' counts over the documents': "Autoria" and the tracks per subject. */
function withSpoken(
  facets: SearchResponse['facets'],
  spoken: SpokenPart,
): SearchResponse['facets'] {
  const merged = withSpokenAuthorships(facets, spoken.byAuthorship);
  return spoken.tracksPerConcept
    ? {
        ...merged,
        concepts: withTrackCounts(merged.concepts, spoken.tracksPerConcept),
      }
    : merged;
}

/** The collections a "Sub-acervo" choice keeps, among those the person sees. */
const chosenTopics = (
  visible: readonly string[],
  filters: ParsedRequest['filters'],
): string[] =>
  filters.topics.length > 0
    ? visible.filter((slug) => filters.topics.includes(slug))
    : [...visible];

/** A track whose document answers as a card is never a "Na fala" card too (BR-8). */
function withoutMerged(
  part: SpokenPart,
  merged: ReadonlySet<string>,
): SpokenPart {
  if (merged.size === 0) return part;
  return { ...part, hits: part.hits.filter((hit) => !merged.has(hit.mediaId)) };
}

/**
 * "Buscar em" (BR-9): texts in "Textos"; tracks and the passages left in "♪ Áudios", each
 * track once; null where the person has no audio to hear.
 */
function kindCounts(
  totals: { readonly texts: number; readonly tracks: number },
  spoken: SpokenPart,
): KindCounts {
  return {
    text: totals.texts,
    audio:
      spoken.count === null
        ? null
        : Math.min(MEDIA_COUNT_CAP, totals.tracks + spoken.count),
  };
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
    const audible = this.isAudible(topic, context.viewer);
    let reach = effectiveKinds(parsed.kinds, {
      text: 0,
      audio: audible ? 0 : null,
    });
    let found = await this.documentsOf(topic, { parsed, context, reach });
    const merged = new Set(found.cardTracks);
    const spoken = audible
      ? this.spoken(topic, { request: parsed, context, merged })
      : NO_AUDIO;
    if (spoken.count === null && !reach.includes('text')) {
      // A broken media index means texts only (ADR 0024), even for "Áudios" alone.
      reach = ['text'];
      found = await this.documentsOf(topic, { parsed, context, reach });
    }
    const { response } = found;
    const audio = reach.includes('audio') && spoken.count !== null;
    return {
      ...response,
      items: this.withPassages(response.items, parsed.q),
      facets: audio ? withSpoken(response.facets, spoken) : response.facets,
      media: audio && parsed.offset === 0 ? [...spoken.hits] : [],
      kinds: kindCounts(found.totals, spoken),
    };
  }

  private documentsOf(
    topic: string,
    {
      parsed,
      context,
      reach,
    }: {
      parsed: ParsedRequest;
      context: SearchContext;
      reach: readonly SearchKind[];
    },
  ) {
    return this.deps.documents.searchDocuments(topic, parsed, {
      tracks: context.viewer.tracks,
      kinds: reach,
    });
  }

  /** A track's card carries its best spoken passage (KBC-101 BR-8, FR-9). */
  private withPassages(
    items: SearchResponse['items'],
    q: string,
  ): SearchResponse['items'] {
    const { passages } = this.deps;
    if (!passages || !items.some((item) => item.media)) return items;
    return withSpokenPassages(items, { passages, terms: termsOf(q) });
  }

  /** Whether the collection has audio this person may hear (BR-1, BR-2). */
  private isAudible(topic: string, viewer: SearchViewer): boolean {
    const { media } = this.deps;
    if (!media || !viewer.mayHear) return false;
    try {
      const visible = this.visibleScope(topic, viewer);
      const subjects = this.subjectsFor(viewer);
      return (
        media.hasTranscripts(visible) ||
        (subjects?.countsIn(topic, visible).length ?? 0) > 0
      );
    } catch {
      // A broken media index means texts only, as the passages' search (ADR 0024).
      return false;
    }
  }

  /** The passages, timed and never failing the search: a broken index means texts only. */
  private spoken(
    topic: string,
    {
      request,
      context,
      merged,
    }: {
      request: ParsedRequest;
      context: SearchContext;
      merged: ReadonlySet<string>;
    },
  ): SpokenPart {
    const { viewer, report = () => undefined } = context;
    const startedAt = performance.now();
    const elapsed = () => Math.round(performance.now() - startedAt);
    try {
      const part = withoutMerged(
        this.findSpoken(topic, { ...request, merged }, viewer),
        merged,
      );
      report({ mediaMs: elapsed(), mediaHits: part.hits.length });
      return part;
    } catch (err) {
      report({ mediaMs: elapsed(), mediaHits: 0, mediaError: err });
      return NO_AUDIO;
    }
  }

  /** A linked track is audio to reach even where nothing was transcribed (BR-2). */
  private findSpoken(
    topic: string,
    {
      q,
      filters,
      merged,
    }: ParsedRequest & { readonly merged: ReadonlySet<string> },
    viewer: SearchViewer,
  ): SpokenPart {
    const { media } = this.deps;
    // Asked only where there is audio to hear (isAudible).
    if (!media || !viewer.mayHear) return NO_AUDIO;
    const subjects = this.subjectsFor(viewer);
    if (hasDocumentOnlyFilters(filters)) return { hits: [], count: 0 };
    const topics = chosenTopics(this.visibleScope(topic, viewer), filters);
    const query = { topic, topics, q, filters };
    if (filters.concepts.length > 0 && !subjects) return { hits: [], count: 0 };
    const part =
      filters.concepts.length > 0 && subjects
        ? subjects.find(query)
        : this.passagesIn(media, {
            terms: termsOf(q),
            topics,
            filters,
            tracks: viewer.seesTracks ?? false,
            exceptIds: [...merged],
          });
    return subjects ? this.withSubjectFacets(subjects, query, part) : part;
  }

  /** Subjects only with tracks in sight: `media`, `media-tracks` and `media-subjects`. */
  private subjectsFor(viewer: SearchViewer): SubjectSearch | undefined {
    const allowed = viewer.mayHear && viewer.seesTracks && viewer.seesSubjects;
    return allowed ? this.deps.subjects : undefined;
  }

  private withSubjectFacets(
    subjects: SubjectSearch,
    query: SubjectQuery,
    part: SpokenPart,
  ): SpokenPart {
    const { topics, filters } = query;
    const { authors } = this.deps;
    const mainOf = new Map(topics.map((slug) => [slug, authors.mainOf(slug)]));
    return {
      ...part,
      hits: subjects.withSubjects(part.hits),
      tracksPerConcept: subjects.counts(
        query,
        authorRuleOf(filters.authorships, mainOf),
      ),
    };
  }

  /** Collection-wide counts, each subject with its tracks for who sees them (FR-2). */
  topicFacets(
    topic: string,
    { viewer, report = () => undefined }: SearchContext,
  ): TopicFacets {
    const facets = this.deps.documents.topicFacets(topic, {
      tracks: viewer.tracks,
    });
    const subjects = this.subjectsFor(viewer);
    if (!subjects) return facets;
    const startedAt = performance.now();
    try {
      const scope = this.visibleScope(topic, viewer);
      const counted = subjects.countsIn(topic, scope);
      return { ...facets, concepts: withTrackCounts(facets.concepts, counted) };
    } catch (err) {
      const mediaMs = Math.round(performance.now() - startedAt);
      report({ mediaMs, mediaHits: 0, mediaError: err });
      return facets;
    }
  }

  /** FR-3: the tracks linked to a subject, in the collections the person sees. */
  subjectTracks(
    target: { readonly topic: string; readonly name: string },
    page: SubjectPage,
    viewer: SearchViewer,
  ): SubjectTracksPage {
    const subjects = this.subjectsFor(viewer);
    if (!subjects) return { items: [], total: 0, nextOffset: null };
    const { topic, name } = target;
    const topics = this.visibleScope(topic, viewer);
    return subjects.tracksOf({ topic, topics }, name, page);
  }

  /** The passages under the "Autoria" choice, and the count of each group. */
  private passagesIn(
    media: MediaSearchPort,
    input: {
      readonly terms: readonly string[];
      readonly topics: readonly string[];
      readonly filters: ParsedRequest['filters'];
      readonly tracks: boolean;
      readonly exceptIds: readonly string[];
    },
  ): SpokenPart {
    const { authors } = this.deps;
    const mainOf = new Map(
      input.topics.map((slug) => [slug, authors.mainOf(slug)]),
    );
    const byAuthorship = media.tally({ ...input, mainOf });
    const rule = authorRuleOf(input.filters.authorships, mainOf);
    if (rule === null) return { hits: [], count: 0, byAuthorship };
    const found = media.search({
      ...input,
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
