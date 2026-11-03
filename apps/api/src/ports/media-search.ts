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

/** The transcripts' own index (ADR 0024 §1), in the media database. */
export interface MediaSearchPort {
  search(query: MediaSearchQuery): MediaSearchResult;
  /** Whether any of these collections has a searchable (transcribed) media. */
  hasTranscripts(topics: readonly string[]): boolean;
}

/** Start and end markers of a match in `marked`. */
export const MATCH_OPEN = '\u0002';
export const MATCH_CLOSE = '\u0003';
