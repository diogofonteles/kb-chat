import {
  EMPTY_FILTERS,
  MAX_MEDIA_HITS,
  MEDIA_COUNT_CAP,
  subjectKey,
  type ConceptCount,
  type HitSubject,
  type MediaHit,
  type SearchFilters,
  type SubjectTracksPage,
} from '@kb-chat/contracts';
import type {
  AuthorRule,
  AuthorshipTally,
  LinkedTrack,
  MediaSegmentMatch,
  SubjectCount,
  TrackDetails,
  TrackLinksPort,
} from '../../ports/media-search.js';
import {
  authorRuleOf,
  termsOf,
  toMediaHit,
  type AuthorView,
} from './media-hits.js';

/**
 * A subject hit has no text matched to score: it sits among the documents, neither above the
 * good matches nor below everything (KBC-070).
 */
const SUBJECT_SCORE = 0.5;
/** Tracks whose best passage is read to choose the MAX_MEDIA_HITS shown. */
const PASSAGE_POOL = 25;

/** The subjects of a collection as the search reads them (`SubjectDirectory`). */
export interface SubjectLookup {
  namesIn(topic: string): ReadonlyMap<string, string>;
  keysNamed(topic: string, names: readonly string[]): string[];
  tracksLinkedTo(keys: readonly string[]): string[];
  shownOn(
    tracks: readonly { readonly mediaId: string; readonly topic: string }[],
  ): ReadonlyMap<string, HitSubject[]>;
}

export interface SubjectSearchDeps {
  readonly links: TrackLinksPort;
  readonly lookup: SubjectLookup;
  readonly authors: AuthorView;
}

/** One search over the tracks of a subject, inside what the person sees. */
export interface SubjectQuery {
  readonly topic: string;
  readonly topics: readonly string[];
  readonly q: string;
  readonly filters: SearchFilters;
}

export interface SubjectPart {
  readonly hits: readonly MediaHit[];
  readonly count: number;
  readonly byAuthorship: AuthorshipTally;
}

/** The tracks a search reaches, split by whether it has a passage to show. */
interface Reach {
  readonly terms: readonly string[];
  readonly speaking: readonly LinkedTrack[];
  readonly wordless: readonly LinkedTrack[];
}

export interface SubjectPage {
  readonly offset: number;
  readonly limit: number;
}

/** The words a track must hold; none when the question is only the subject's name (BR-2). */
function requiredTerms(q: string, filters: SearchFilters): readonly string[] {
  const key = subjectKey(q);
  const isSubject = filters.concepts.some((name) => subjectKey(name) === key);
  return isSubject ? [] : termsOf(q);
}

const inGroup = (
  track: LinkedTrack,
  rule: AuthorRule,
  mainOf: (topic: string) => string | null,
): boolean => {
  if (rule.kind === 'any') return true;
  const main = mainOf(track.topic);
  if (rule.kind === 'main') return main !== null && track.author === main;
  return main === null || track.author !== main;
};

/** A concept's panel and the search filtered by it: tracks by accepted link (KBC-070). */
export class SubjectSearch {
  constructor(private readonly deps: SubjectSearchDeps) {}

  /**
   * BR-2: every track linked to the subject, or with text those that hold it in the speech,
   * title or summary. Passages come first, as a search ranks them; then the tracks with no
   * passage, the newest first.
   */
  find(query: SubjectQuery): SubjectPart {
    const { topic, topics, q, filters } = query;
    const { links, lookup } = this.deps;
    const keys = lookup.keysNamed(topic, filters.concepts);
    const ids = lookup.tracksLinkedTo(keys);
    const linked = links.linkedTracks({ topics, ids });
    return this.part(query, this.reached(linked, q, filters));
  }

  /** Which linked tracks enter, and the ones with the words spoken first. */
  private reached(
    linked: readonly LinkedTrack[],
    q: string,
    filters: SearchFilters,
  ): Reach {
    const { links } = this.deps;
    const terms = termsOf(q);
    const spoken = new Set(
      links.speakingTracks(
        terms,
        linked.map((track) => track.mediaId),
      ),
    );
    const speaking = linked.filter((one) => spoken.has(one.mediaId));
    const unspoken = linked.filter((one) => !spoken.has(one.mediaId));
    const required = requiredTerms(q, filters);
    if (required.length === 0) return { terms, speaking, wordless: unspoken };
    const about = links.tracksAbout(required);
    const wordless = unspoken.filter((one) => about.has(one.mediaId));
    return { terms, speaking, wordless };
  }

  /** Every track once: passages first, the rest newest first. */
  private part(query: SubjectQuery, reach: Reach): SubjectPart {
    const { authors } = this.deps;
    const { topics, filters } = query;
    const mainOf = new Map(topics.map((slug) => [slug, authors.mainOf(slug)]));
    const tracks = [...reach.speaking, ...reach.wordless];
    const group = (kind: 'main' | 'others') =>
      tracks.filter((one) => inGroup(one, { kind, mainOf }, authors.mainOf))
        .length;
    const byAuthorship = { main: group('main'), others: group('others') };
    const rule = authorRuleOf(filters.authorships, mainOf);
    if (rule === null) return { hits: [], count: 0, byAuthorship };
    const allowed = (one: LinkedTrack) => inGroup(one, rule, authors.mainOf);
    const passages = this.passages(reach.terms, reach.speaking.filter(allowed));
    const chosen = reach.wordless
      .filter(allowed)
      .slice(0, MAX_MEDIA_HITS - passages.length);
    return {
      hits: [...passages, ...this.subjectHits(chosen)],
      count: Math.min(countUnder(rule, byAuthorship), MEDIA_COUNT_CAP),
      byAuthorship,
    };
  }

  /** The best passage of each track, normal confidence first, the best ones on top. */
  private passages(
    terms: readonly string[],
    speaking: readonly LinkedTrack[],
  ): MediaHit[] {
    const { links, authors } = this.deps;
    const pool = speaking.slice(0, PASSAGE_POOL).map((one) => one.mediaId);
    return links
      .bestPassages(terms, pool)
      .sort(byConfidenceThenRelevance)
      .slice(0, MAX_MEDIA_HITS)
      .map((match) => toMediaHit(match, authors));
  }

  private subjectHits(tracks: readonly LinkedTrack[]): MediaHit[] {
    const { links, authors } = this.deps;
    return links
      .trackDetails(tracks.map((one) => one.mediaId))
      .map((track) => toSubjectHit(track, authors));
  }

  /** The hits with their accepted subjects: a recording has none. */
  withSubjects(hits: readonly MediaHit[]): MediaHit[] {
    const shown = this.deps.lookup.shownOn(hits);
    return hits.map((hit) => ({
      ...hit,
      subjects: shown.get(hit.mediaId) ?? [],
    }));
  }

  /**
   * Tracks per subject (BR-4), each subject ignoring its own selection, under the question
   * and the other filters. Nothing but what `topics` holds is ever counted.
   */
  counts(query: SubjectQuery, rule: AuthorRule | null): ConceptCount[] {
    if (rule === null) return [];
    const { topic, topics, q, filters } = query;
    const { links, lookup } = this.deps;
    const required = requiredTerms(q, filters);
    const ids = required.length === 0 ? undefined : this.holding(required);
    const counted = links.subjectCounts({ topics, authors: rule, ids });
    return namedCounts(counted, lookup.namesIn(topic));
  }

  /** Tracks per subject in these collections, with no question and no filter. */
  countsIn(topic: string, topics: readonly string[]): ConceptCount[] {
    return this.counts(
      { topic, topics, q: '', filters: EMPTY_FILTERS },
      { kind: 'any' },
    );
  }

  /**
   * Tracks with the words in the speech, title or summary. A word too common to look up on
   * every search leaves all (undefined): the count then says what the subject holds, never
   * more than the collections in sight.
   */
  private holding(required: readonly string[]): string[] | undefined {
    const { links } = this.deps;
    const saying = links.saying(required);
    if (saying === null) return undefined;
    return [...new Set([...saying, ...links.tracksAbout(required)])];
  }

  /**
   * FR-3: the tracks linked to a subject, most recent first. A subject that does not exist
   * reads as one with no track: a 404 would tell who sees only a sub-collection which subjects
   * its parent has (BR-3).
   */
  tracksOf(
    target: { readonly topic: string; readonly topics: readonly string[] },
    name: string,
    { offset, limit }: SubjectPage,
  ): SubjectTracksPage {
    const { links, lookup } = this.deps;
    const keys = lookup.keysNamed(target.topic, [name]);
    const ids = lookup.tracksLinkedTo(keys);
    const linked = links.linkedTracks({ topics: target.topics, ids });
    const end = Math.min(offset + limit, linked.length);
    const page = linked.slice(offset, end).map((one) => one.mediaId);
    return {
      items: links
        .trackDetails(page)
        .map((track) => this.toSubjectTrack(track)),
      total: linked.length,
      nextOffset: end < linked.length ? end : null,
    };
  }

  private toSubjectTrack(track: TrackDetails) {
    const {
      mediaId: id,
      topic,
      title,
      durationMs,
      summary,
      parentTitle,
    } = track;
    const author =
      track.author === null
        ? null
        : this.deps.authors.authorOf(topic, track.author);
    return { id, topic, title, author, durationMs, summary, parentTitle };
  }
}

const byConfidenceThenRelevance = (
  a: MediaSegmentMatch,
  b: MediaSegmentMatch,
): number =>
  Number(a.confidence === 'low') - Number(b.confidence === 'low') ||
  a.bm25 - b.bm25;

function countUnder(rule: AuthorRule, tally: AuthorshipTally): number {
  if (rule.kind === 'main') return tally.main;
  if (rule.kind === 'others') return tally.others;
  return tally.main + tally.others;
}

function namedCounts(
  counted: readonly SubjectCount[],
  names: ReadonlyMap<string, string>,
): ConceptCount[] {
  return counted.flatMap(({ key, tracks }) => {
    const value = names.get(key);
    return value === undefined ? [] : [{ value, count: 0, tracks }];
  });
}

function toSubjectHit(track: TrackDetails, authors: AuthorView): MediaHit {
  const main = authors.mainOf(track.topic);
  return {
    mediaId: track.mediaId,
    topic: track.topic,
    title: track.title,
    authorship:
      track.author !== null && track.author === main
        ? 'mestre-laercio'
        : 'outros-autores',
    author:
      track.author === null
        ? null
        : authors.authorOf(track.topic, track.author),
    text: track.summary ?? '',
    highlights: [],
    startMs: 0,
    endMs: track.durationMs ?? 0,
    confidence: 'normal',
    score: SUBJECT_SCORE,
    match: 'subject',
    subjects: [],
  };
}

/** The documents' counts with each subject's tracks beside them (BR-4). */
export function withTrackCounts(
  concepts: readonly ConceptCount[],
  tracks: readonly ConceptCount[],
): ConceptCount[] {
  const left = new Map(tracks.map((one) => [subjectKey(one.value), one]));
  const merged = concepts.map((one) => {
    const key = subjectKey(one.value);
    const counted = left.get(key)?.tracks ?? 0;
    left.delete(key);
    return { ...one, tracks: counted };
  });
  return [...merged, ...left.values()];
}
