import {
  MAX_MEDIA_HITS,
  MEDIA_COUNT_CAP,
  subjectKey,
  type ConceptCount,
  type HitSubject,
  type MediaHit,
  type SearchFilters,
  type SubjectTracksPage,
} from '@kb-chat/contracts';
import { AppError } from '../../app-error.js';
import type {
  AuthorRule,
  AuthorshipTally,
  LinkedTrack,
  MediaSearchPort,
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
  readonly media: MediaSearchPort;
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

interface PartInput {
  readonly query: SubjectQuery;
  readonly terms: readonly string[];
  readonly within: readonly string[];
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
    const terms = termsOf(q);
    const speaking = new Set(this.speaking(terms, linked));
    const wordless = this.withoutPassage(linked, {
      speaking,
      required: requiredTerms(q, filters),
    });
    const within = linked.map((track) => track.mediaId);
    return this.part({ query, terms, within, wordless });
  }

  private speaking(
    terms: readonly string[],
    linked: readonly LinkedTrack[],
  ): string[] {
    return this.deps.links.speakingTracks(
      terms,
      linked.map((track) => track.mediaId),
    );
  }

  /** The tracks that enter with no passage: by the subject alone, or by title or summary. */
  private withoutPassage(
    linked: readonly LinkedTrack[],
    {
      speaking,
      required,
    }: {
      readonly speaking: ReadonlySet<string>;
      readonly required: readonly string[];
    },
  ): LinkedTrack[] {
    const unspoken = linked.filter((one) => !speaking.has(one.mediaId));
    if (required.length === 0) return unspoken;
    const about = this.deps.links.tracksAbout(required);
    return unspoken.filter((one) => about.has(one.mediaId));
  }

  private part({ query, terms, within, wordless }: PartInput): SubjectPart {
    const { authors } = this.deps;
    const { topics, filters } = query;
    const mainOf = new Map(topics.map((slug) => [slug, authors.mainOf(slug)]));
    const byAuthorship = this.tallied(
      { query, terms, within, wordless },
      mainOf,
    );
    const rule = authorRuleOf(filters.authorships, mainOf);
    if (rule === null) return { hits: [], count: 0, byAuthorship };
    const passages = this.passages({ query, terms, within, wordless }, rule);
    const chosen = wordless
      .filter((one) => inGroup(one, rule, authors.mainOf))
      .slice(0, MAX_MEDIA_HITS - passages.length);
    return {
      hits: [...passages, ...this.subjectHits(chosen)],
      count: Math.min(countUnder(rule, byAuthorship), MEDIA_COUNT_CAP),
      byAuthorship,
    };
  }

  /** Passages plus the tracks with none, per "Autoria" group. */
  private tallied(
    { query, terms, within, wordless }: PartInput,
    mainOf: ReadonlyMap<string, string | null>,
  ): AuthorshipTally {
    const { media, authors } = this.deps;
    const { topics } = query;
    const spoken =
      within.length === 0
        ? { main: 0, others: 0 }
        : media.tally({ terms, topics, mainOf, within });
    const group = (kind: 'main' | 'others') =>
      wordless.filter((one) => inGroup(one, { kind, mainOf }, authors.mainOf))
        .length;
    return {
      main: spoken.main + group('main'),
      others: spoken.others + group('others'),
    };
  }

  private passages(
    { query, terms, within }: PartInput,
    rule: AuthorRule,
  ): MediaHit[] {
    const { media, authors } = this.deps;
    if (within.length === 0) return [];
    return media
      .search({
        terms,
        topics: query.topics,
        authors: rule,
        within,
        limit: MAX_MEDIA_HITS,
        count: false,
      })
      .matches.map((match) => toMediaHit(match, authors));
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
    const ids =
      required.length === 0 ? undefined : this.holding(required, topics);
    const counted = links.subjectCounts({ topics, authors: rule, ids });
    return namedCounts(counted, lookup.namesIn(topic));
  }

  /** Linked tracks with the words in the speech, title or summary. */
  private holding(
    required: readonly string[],
    topics: readonly string[],
  ): string[] {
    const { links } = this.deps;
    const ids = links.linkedTracks({ topics }).map((one) => one.mediaId);
    const about = links.tracksAbout(required);
    return [
      ...new Set([
        ...links.speakingTracks(required, ids),
        ...ids.filter((id) => about.has(id)),
      ]),
    ];
  }

  /** FR-3: the tracks linked to a subject, most recent first. */
  tracksOf(
    target: { readonly topic: string; readonly topics: readonly string[] },
    name: string,
    { offset, limit }: SubjectPage,
  ): SubjectTracksPage {
    const { links, lookup } = this.deps;
    const keys = lookup.keysNamed(target.topic, [name]);
    if (keys.length === 0)
      throw new AppError('NOT_FOUND', 'Unknown subject in this collection');
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
