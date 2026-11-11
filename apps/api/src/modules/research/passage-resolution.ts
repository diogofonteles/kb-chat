import {
  SOURCE_CITATION,
  clockSeconds,
  snapToSegment,
  type AnswerSource,
  type TrackPassage,
} from '@kb-chat/contracts';
import type { ShelfSegment, TrackShelf } from '../../ports/track-shelf.js';
import type { ShownPassages, SourceBook } from './source-book.js';

interface Citation {
  readonly n: number;
  /** The time as written ("0:41"); empty for a plain [n]. */
  readonly at: string;
}

const citationsOf = (answer: string): Citation[] =>
  [...answer.matchAll(new RegExp(SOURCE_CITATION.source, 'g'))].map(
    (match) => ({ n: Number(match[1]), at: match[2] ?? '' }),
  );

/**
 * Which second a citation stands for (BR-5): the written time only when that anchor was
 * shown to the model for that source in this turn; else the last passage shown of it; else
 * none (the track's start).
 */
function secondsOf(
  citation: Citation,
  shown: ShownPassages | undefined,
): number | null {
  const written = citation.at ? clockSeconds(citation.at) : null;
  if (written !== null && shown?.anchors.has(written)) return written;
  return shown?.last ?? null;
}

export interface PassageInput {
  /** The answer as the reader sees it. */
  readonly answer: string;
  readonly sources: readonly AnswerSource[];
  readonly shownOf: (n: number) => ShownPassages | undefined;
  readonly segmentsOf: (mediaId: string) => readonly ShelfSegment[];
}

/**
 * Every "[n@m:ss]" and "[n]" of a track source becomes a passage with the exact times of its
 * media.db segment, once each, in the answer's order (ADR 0035 §6 a, b). Texts, uncited
 * tracks and sources of older answers are left as they are.
 */
export function resolvePassages(input: PassageInput): AnswerSource[] {
  const citations = citationsOf(input.answer);
  return input.sources.map((source) => {
    if (!source.media) return source;
    const cited = citations.filter((one) => one.n === source.n);
    if (cited.length === 0) return source;
    const segments = input.segmentsOf(source.media.mediaId);
    const shown = input.shownOf(source.n);
    const passages: TrackPassage[] = [];
    for (const citation of cited) {
      if (passages.some((one) => one.at === citation.at)) continue;
      const span = snapToSegment(segments, secondsOf(citation, shown));
      passages.push({ at: citation.at, ...span });
    }
    return { ...source, passages };
  });
}

/**
 * The turn's sources with their passages, once the answer is written; null when no track
 * is cited (nothing to send again).
 */
export function resolveTurnPassages(
  answer: string,
  { book, tracks }: { readonly book: SourceBook; readonly tracks?: TrackShelf },
): AnswerSource[] | null {
  if (!tracks) return null;
  const sources = book.list();
  if (!sources.some((source) => source.media)) return null;
  const resolved = resolvePassages({
    answer,
    sources,
    shownOf: (n) => book.shownOf(n),
    segmentsOf: (mediaId) => tracks.segmentsOf(mediaId),
  });
  return resolved.some((source) => source.passages) ? resolved : null;
}
