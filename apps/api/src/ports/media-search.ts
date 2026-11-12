import type { TranscriptConfidence } from '@kb-chat/contracts';

/**
 * Who a passage must be by, per collection searched (KBC-039 BR-2): any author, the
 * collection's main author only, or anyone but him ("Outros autores", no author included).
 */
export type AuthorRule =
  | { readonly kind: 'any' }
  | {
      readonly kind: 'main' | 'others';
      /** The main author's id per collection; null when the collection has none. */
      readonly mainOf: ReadonlyMap<string, string | null>;
    };

export interface MediaSearchQuery {
  /** Words that must all be said in the segment (letters and digits only). */
  readonly terms: readonly string[];
  /** The collections to look in (a parent and its sub-collections the person sees). */
  readonly topics: readonly string[];
  readonly authors: AuthorRule;
  readonly limit: number;
  /** Has `media-tracks`: a passage inside a track is the track's (KBC-068 BR-6). */
  readonly tracks?: boolean;
  /** Count the matches too (default); off when the caller has the tally already. */
  readonly count?: boolean;
  /** Media left out: tracks whose document already answers as a card (KBC-101 BR-8). */
  readonly exceptIds?: readonly string[];
  /**
   * The levels the person sees in these collections, which share one scale (KBC-105); null or
   * absent: every audio. Each track answers by its own level, and a recording's passage inside
   * a track above them does not answer (KBC-106).
   */
  readonly levels?: readonly string[] | null;
}

/** Matching segments per "Autoria" group, each up to MEDIA_COUNT_CAP. */
export interface AuthorshipTally {
  readonly main: number;
  readonly others: number;
}

/** One matching segment of a current transcript. */
export interface MediaSegmentMatch {
  readonly mediaId: string;
  readonly topic: string;
  readonly title: string;
  /** The media's author id (ADR 0030 §4), or null ("Outros autores"). */
  readonly author: string | null;
  /** The segment's text with each match between U+0002 and U+0003. */
  readonly marked: string;
  readonly startMs: number;
  readonly endMs: number;
  readonly confidence: TranscriptConfidence;
  /** FTS5 bm25: lower is better (negative). */
  readonly bm25: number;
}

export interface MediaSearchResult {
  /** Normal confidence first, then by relevance (BR-3). */
  readonly matches: readonly MediaSegmentMatch[];
  /** Matching segments, counted up to MEDIA_COUNT_CAP. */
  readonly total: number;
}

/** Which tracks: these collections, and among these ids when given. */
export interface TrackScope {
  readonly topics: readonly string[];
  readonly ids?: readonly string[];
}

/** A published track with an accepted subject: what its group in "Autoria" needs. */
export interface LinkedTrack {
  readonly mediaId: string;
  readonly topic: string;
  /** The media's author id, or null ("Outros autores"). */
  readonly author: string | null;
}

/** What a track's card or line shows. */
export interface TrackDetails extends LinkedTrack {
  readonly title: string;
  readonly durationMs: number | null;
  readonly summary: string | null;
  readonly parentTitle: string;
}

/** Tracks with one accepted subject (`concept:<key>` or `free:<id>`). */
export interface SubjectCount {
  readonly key: string;
  readonly tracks: number;
}

/** Where a media says the words: `place` is the segment's row, for `passagesAt`. */
export interface SpokenPlace {
  readonly mediaId: string;
  readonly place: number;
}

export interface SpokenQuery {
  readonly terms: readonly string[];
  readonly ids: readonly string[];
  /** As in `search`: a passage inside a track is the track's. */
  readonly tracks: boolean;
  readonly limit: number;
  /**
   * Per collection the levels the person hears there (null: all): a recording's passage inside
   * a track above them never answers (KBC-106 BR-2). Absent: every level.
   */
  readonly levelsByTopic?: ReadonlyMap<string, readonly string[] | null>;
}

/** Which of the asked media say the words (KBC-096). */
export interface SpokenAmong {
  /** One place per media, the best first. */
  readonly places: readonly SpokenPlace[];
  /** More media say them than the limit. */
  readonly more: boolean;
}

/** The transcripts' own index (ADR 0024 §1), in the media database. */
export interface MediaSearchPort {
  search(query: MediaSearchQuery): MediaSearchResult;
  /**
   * Matching segments by the collection's main author and by everyone else, in one pass
   * (the "Autoria" counts and the passages' total, NFR-1).
   */
  tally(query: {
    readonly terms: readonly string[];
    readonly topics: readonly string[];
    readonly mainOf: ReadonlyMap<string, string | null>;
    /** As in `search`: both must count the same passages. */
    readonly tracks?: boolean;
    /** As in `search`. */
    readonly exceptIds?: readonly string[];
    /** As in `search`. */
    readonly levels?: readonly string[] | null;
  }): AuthorshipTally;
  /** Whether any of these collections has a searchable (transcribed) media at these levels. */
  hasTranscripts(
    topics: readonly string[],
    levels?: readonly string[] | null,
  ): boolean;
}

/** What tracks and their subjects need from the same index (KBC-070). */
export interface TrackLinksPort {
  /** Published tracks with an accepted subject, newest first (KBC-070 FR-3). */
  linkedTracks(scope: TrackScope): LinkedTrack[];
  /** Of these tracks, those where every word is said in one segment. */
  speakingTracks(terms: readonly string[], ids: readonly string[]): string[];
  /** Each of these tracks' best passage for the words, in the order of `ids`. */
  bestPassages(
    terms: readonly string[],
    ids: readonly string[],
  ): MediaSegmentMatch[];
  /** Tracks with accepted links that say the words; null for a word too common to ask. */
  saying(terms: readonly string[]): ReadonlySet<string> | null;
  /** Tracks with every word in their title and summary together (BR-2). */
  tracksAbout(terms: readonly string[]): ReadonlySet<string>;
  /** The tracks in `ids`, in that order. */
  trackDetails(ids: readonly string[]): TrackDetails[];
  /** Of these media, those where every word is said in one segment, each with its best. */
  spokenAmong(query: SpokenQuery): SpokenAmong;
  /** The passages at these places, marked for the words, in no set order. */
  passagesAt(
    terms: readonly string[],
    places: readonly number[],
  ): MediaSegmentMatch[];
  /** Accepted links per subject over published tracks: suggestions never count (BR-1). */
  subjectCounts(
    scope: TrackScope & { readonly authors: AuthorRule },
  ): SubjectCount[];
}

/** Start and end markers of a match in `marked`. */
export const MATCH_OPEN = '\u0002';
export const MATCH_CLOSE = '\u0003';
