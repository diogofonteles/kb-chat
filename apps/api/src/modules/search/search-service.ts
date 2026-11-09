import type {
  SearchHit,
  SearchHitMedia,
  SearchKind,
  SearchRequest,
  SearchFilters,
  SearchResponse,
  TopicFacets,
} from '@kb-chat/contracts';
import {
  MAX_RESULTS,
  SEARCH_KINDS,
  searchRequestSchema,
  snapToSegment,
} from '@kb-chat/contracts';
import type { z } from 'zod';
import { AppError } from '../../app-error.js';
import type {
  IndexHit,
  IndexQuery,
  SearchIndexPort,
} from '../../ports/search-index.js';
import type { TrackShelf } from '../../ports/track-shelf.js';
import type { VaultReaderPort } from '../../ports/vault-reader.js';
import {
  isSeenDocument,
  isTrackEntry,
  splitFrontmatter,
  type CatalogEntry,
  type CatalogMedia,
  type CatalogRegistry,
  type TopicCatalog,
} from '../catalog/index.js';
import {
  cardTracks,
  countFacets,
  groupCopies,
  kindTotals,
  refine,
  type Candidate,
  type CopyGroup,
} from './refine.js';
import { cleanSnippet } from './snippet.js';
import { trackSnippet } from './track-snippet.js';

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
 * Which cataloged documents a search may return: texts, and the track documents a shelf
 * confirms for this person (ADR 0035 §5): the documents search (T2) builds it for who has
 * `media` and `media-tracks` (KBC-101 BR-7), the research tools for who may research tracks
 * (KBC-099 BR-4). Without a shelf, texts only.
 */
export interface SearchScope {
  readonly tracks?: TrackShelf | undefined;
  /** What comes back (KBC-101 BR-9): texts, tracks or both (default); counts ignore it. */
  readonly kinds?: readonly SearchKind[];
}

/** The documents search with what the spoken passages need to merge into it (KBC-101). */
export interface DocumentSearch {
  readonly response: SearchResponse;
  /**
   * Tracks shown as cards under the filters, up to the result cap (BR-8): their passages
   * leave "Na fala". With texts alone chosen, the cards "Ambos" would show, so the counts
   * ignore the choice (BR-9).
   */
  readonly cardTracks: readonly string[];
  /** Result cards per kind under the filters, whatever kinds were chosen (BR-9). */
  readonly totals: { readonly texts: number; readonly tracks: number };
}

/** A track's document is a document of the collection while its shelf confirms it. */
const admitted = (
  entry: CatalogEntry,
  { topic, tracks }: { topic: string; tracks: TrackShelf | undefined },
): boolean => isSeenDocument(entry, { topic, tracks });

const ofKind = (kinds: readonly SearchKind[]) => (group: CopyGroup) =>
  kinds.includes(group.lead.entry.media ? 'audio' : 'text');

/** The tracks shown as cards; with texts alone chosen, the ones "Ambos" shows (BR-8, BR-9). */
const cardsOf = (
  groups: readonly CopyGroup[],
  { kinds, filters }: { kinds: readonly SearchKind[]; filters: SearchFilters },
): string[] =>
  cardTracks(kinds.includes('audio') ? groups.filter(ofKind(kinds)) : groups, {
    filters,
    maxResults: MAX_RESULTS,
  });

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
    scope: SearchScope = {},
  ): Promise<SearchResponse> {
    return (await this.searchDocuments(topic, request, scope)).response;
  }

  /** The search, the tracks it matched and the cards per kind (KBC-101). */
  async searchDocuments(
    topic: string,
    request: SearchRequest,
    { tracks, kinds = SEARCH_KINDS }: SearchScope = {},
  ): Promise<DocumentSearch> {
    const { q, mode, limit, offset, filters } =
      searchRequestSchema.parse(request);
    const startedAt = performance.now();
    const found = await this.foundIn(topic, { q, mode, filters, tracks });
    const groups = mergeByScore(found);
    const { page, ...refined } = refine(groups.filter(ofKind(kinds)), {
      filters,
      offset,
      limit,
      maxResults: MAX_RESULTS,
    });
    const totals = kindTotals(groups, filters);
    const response: SearchResponse = {
      ...refined,
      items: await this.hitsOf(page, tracks),
      trackTotal: kinds.includes('audio') ? totals.tracks : 0,
      capped: found.some((one) => one.capped),
      // Documents only: SearchWithMedia adds the spoken passages (KBC-039).
      media: [],
      kinds: { text: totals.texts, audio: null },
      mode,
      tookMs: Math.round(performance.now() - startedAt),
    };
    const cards = cardsOf(groups, { kinds, filters });
    return { response, cardTracks: cards, totals };
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
      tracks,
    }: Pick<SearchFilterQuery, 'q' | 'mode' | 'filters'> & {
      tracks: TrackShelf | undefined;
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
      this.keepCataloged(catalog, { hits: hits.kept, tracks }),
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

  /**
   * Collection-wide counts per facet value ("no acervo" counts): the texts, and the track
   * documents the shelf confirms for this person (KBC-101 FR-7).
   */
  topicFacets(topic: string, { tracks }: SearchScope = {}): TopicFacets {
    return countFacets(() => this.documentsIn(topic, tracks));
  }

  /** Every document of the scope this person may see, with its collection. */
  documentsIn(
    topic: string,
    tracks?: TrackShelf,
  ): (CatalogEntry & { readonly topic: string })[] {
    return this.requireScope(topic).flatMap((catalog) => {
      const slug = catalog.topic.slug;
      return [...catalog.entries.values()]
        .filter((entry) => admitted(entry, { topic: slug, tracks }))
        .map((entry) => ({ ...entry, topic: slug }));
    });
  }

  private keepCataloged(
    catalog: TopicCatalog,
    {
      hits,
      tracks,
    }: {
      hits: readonly IndexHit[];
      tracks: TrackShelf | undefined;
    },
  ): Candidate[] {
    const known: Candidate[] = [];
    const topic = catalog.topic.slug;
    for (const hit of hits) {
      const entry = catalog.entries.get(hit.id);
      // The collection rides along for the "Sub-acervo" filter (KBC-048 FR-4).
      if (entry && admitted(entry, { topic, tracks }))
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

  private async toSearchHit(
    group: CopyGroup,
    tracks: TrackShelf | undefined,
  ): Promise<SearchHit> {
    const { lead, copies } = group;
    const { hit, entry } = lead;
    const catalog = this.topicOf.get(group);
    if (!catalog) throw new Error('search group without its collection');
    const topic = catalog.topic.slug;
    const source = {
      body: await this.bodyOf(topic, hit.id),
      summary: entry.summary,
    };
    const track =
      entry.media && tracks
        ? trackHit(entry.media, { raw: hit.snippet, source, topic, tracks })
        : null;
    return {
      ...facetsOf(entry),
      topic,
      id: entry.id,
      title: entry.title,
      snippet: track?.snippet ?? cleanSnippet(hit.snippet, source),
      score: hit.score,
      copies: copies.map((copy) => ({ id: copy.id, title: copy.title })),
      ...(track && { media: track.media }),
    };
  }

  private hitsOf(
    page: readonly CopyGroup[],
    tracks: TrackShelf | undefined,
  ): Promise<SearchHit[]> {
    return Promise.all(page.map((group) => this.toSearchHit(group, tracks)));
  }

  private async bodyOf(topic: string, id: string): Promise<string> {
    const text = await this.deps.vault.readDocument(topic, id);
    return text === null ? '' : splitFrontmatter(text).body;
  }
}

/** What a card says of a document's facets and authorship. */
const facetsOf = (entry: CatalogEntry) => ({
  genre: entry.genre,
  depth: entry.depth,
  relevance: entry.relevance,
  concepts: [...entry.concepts],
  authorship: entry.authorship,
  author: entry.author,
});

/** A track's card: its snippet and where the T22 panel opens (KBC-101 FR-8, BR-11). */
function trackHit(
  media: CatalogMedia,
  input: {
    readonly raw: string;
    readonly source: { body: string; summary: string | null };
    readonly topic: string;
    readonly tracks: TrackShelf;
  },
): { snippet: string; media: SearchHitMedia } {
  const { raw, source, topic, tracks } = input;
  const { snippet, seconds } = trackSnippet(raw, source);
  const span = snapToSegment(tracks.segmentsOf(media.mediaId), seconds);
  const shelf = tracks.trackOf(topic, media);
  return {
    snippet,
    media: {
      mediaId: media.mediaId,
      kind: media.kind,
      recordingTitle: media.recordingTitle,
      ...(media.ordinal !== null && { ordinal: media.ordinal }),
      ...(media.total !== null && { total: media.total }),
      durationMs: media.durationMs,
      ...span,
      confidence: shelf?.confidence ?? media.confidence,
      stale: shelf?.stale ?? false,
    },
  };
}
