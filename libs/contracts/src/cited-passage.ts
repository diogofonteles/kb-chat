import type { SegmentSpan } from './track-citations.js';

/** A segment as a cited passage's bounds need it (KBC-156). */
export interface SpokenSegment extends SegmentSpan {
  readonly text: string;
  /** Who speaks it, when the transcript says: a change of voice ends the passage. */
  readonly voice?: number | null;
  /** A part this person may not hear (KBC-106 BR-2): never inside a passage. */
  readonly restricted?: boolean;
}

/** Below both minimums the passage takes the next (else the previous) whole sentence. */
export const PASSAGE_MIN_MS = 8_000;
export const PASSAGE_MIN_WORDS = 12;
/** Nothing is added past it; the cited segment alone is never cut. */
export const PASSAGE_MAX_MS = 45_000;
/** Context is contiguous speech: a longer silence ends it (the player plays the whole span). */
export const PASSAGE_MAX_PAUSE_MS = 3_000;

const SENTENCE_END = /[.!?…]["'”’»)\]]*$/u;
const WORD = /[\p{L}\p{N}]/u;

interface Bounds {
  readonly first: number;
  readonly last: number;
}

/** The segments of a track and how they read, for one widening. */
class Sentences {
  private readonly punctuated: boolean;

  constructor(private readonly segments: readonly SpokenSegment[]) {
    this.punctuated = segments.some(
      (one) => !one.restricted && SENTENCE_END.test(one.text.trim()),
    );
  }

  /** Without any sentence punctuation, each segment is a sentence (BR-1). */
  ends(index: number): boolean {
    const one = this.segments[index];
    return !this.punctuated || SENTENCE_END.test(one?.text.trim() ?? '');
  }

  /** Whether the neighbour `to` may join the passage that holds `from` (BR-4). */
  joins(from: number, to: number): boolean {
    const a = this.segments[from];
    const b = this.segments[to];
    if (!a || !b || b.restricted) return false;
    const voiced = typeof a.voice === 'number' && typeof b.voice === 'number';
    return !voiced || a.voice === b.voice;
  }

  /** Joins with no silence longer than PASSAGE_MAX_PAUSE_MS between them (BR-2). */
  touches(from: number, to: number): boolean {
    const [early, late] = from < to ? [from, to] : [to, from];
    const pause =
      (this.segments[late]?.startMs ?? 0) - (this.segments[early]?.endMs ?? 0);
    return pause <= PASSAGE_MAX_PAUSE_MS && this.joins(from, to);
  }

  fits({ first, last }: Bounds): boolean {
    const start = this.segments[first]?.startMs ?? 0;
    return (this.segments[last]?.endMs ?? 0) - start <= PASSAGE_MAX_MS;
  }

  enough({ first, last }: Bounds): boolean {
    const span = this.segments.slice(first, last + 1);
    const ms = (span.at(-1)?.endMs ?? 0) - (span[0]?.startMs ?? 0);
    const words = span
      .flatMap((one) => one.text.split(/\s+/))
      .filter((word) => WORD.test(word)).length;
    return ms >= PASSAGE_MIN_MS || words >= PASSAGE_MIN_WORDS;
  }

  span({ first, last }: Bounds): SegmentSpan {
    return {
      startMs: this.segments[first]?.startMs ?? 0,
      endMs: this.segments[last]?.endMs ?? 0,
    };
  }

  /** One segment more on each open side of the sentence; null when neither moves (BR-1). */
  completeStep(at: Bounds): Bounds | null {
    const first = this.opensBefore(at) ? at.first - 1 : at.first;
    const ahead = { first, last: at.last + 1 };
    const last = this.closesAfter(at, ahead) ? ahead.last : at.last;
    return first === at.first && last === at.last ? null : { first, last };
  }

  private opensBefore({ first, last }: Bounds): boolean {
    if (first === 0 || this.ends(first - 1)) return false;
    return (
      this.joins(first, first - 1) && this.fits({ first: first - 1, last })
    );
  }

  private closesAfter({ last }: Bounds, ahead: Bounds): boolean {
    return !this.ends(last) && this.joins(last, last + 1) && this.fits(ahead);
  }

  /** The next whole sentence joined, or null when it cannot all come in. */
  nextSentence({ first, last }: Bounds): Bounds | null {
    let end = last;
    do {
      if (!this.touches(end, end + 1)) return null;
      end += 1;
    } while (!this.ends(end));
    const grown = { first, last: end };
    return this.fits(grown) ? grown : null;
  }

  /** The previous whole sentence joined, or null when it cannot all come in. */
  previousSentence({ first, last }: Bounds): Bounds | null {
    let start = first;
    do {
      if (!this.touches(start, start - 1)) return null;
      start -= 1;
    } while (start > 0 && !this.ends(start - 1));
    const grown = { first: start, last };
    return this.fits(grown) ? grown : null;
  }
}

/**
 * The segments a span falls on (an empty span: the one it starts in; else a zero-length one
 * at its time, which then grows into the speech beside it); null when none.
 */
function boundsOf(
  segments: readonly SpokenSegment[],
  span: SegmentSpan,
): Bounds | null {
  const until = Math.max(span.endMs, span.startMs + 1);
  const overlapping = segments.findIndex(
    (one) => one.startMs < until && one.endMs > span.startMs,
  );
  const first =
    overlapping >= 0
      ? overlapping
      : segments.findIndex(
          (one) => one.startMs === one.endMs && one.startMs === span.startMs,
        );
  if (first < 0) return null;
  let last = first;
  while ((segments[last + 1]?.startMs ?? Infinity) < until) last += 1;
  return { first, last };
}

/** The segment of `at` the citation stands on: the one starting in its second, else holding it. */
function anchorIn(
  segments: readonly SpokenSegment[],
  { first, last }: Bounds,
  citedMs: number,
): number {
  const second = Math.floor(citedMs / 1000);
  const inside = segments.slice(first, last + 1);
  const at = inside.findIndex(
    (one) => Math.floor(one.startMs / 1000) === second,
  );
  const found =
    at >= 0
      ? at
      : inside.findIndex(
          (one) => one.startMs <= citedMs && citedMs < one.endMs,
        );
  return first + Math.max(found, 0);
}

/**
 * A saved span cut back at a part the person may not hear or a change of voice, around the
 * cited segment (BR-4): the one case a passage shrinks. Sides with nothing to cut keep their
 * time; null when the cited segment itself may not be heard.
 */
function clipped(
  segments: readonly SpokenSegment[],
  span: SegmentSpan,
  { found, citedMs }: { readonly found: Bounds; readonly citedMs: number },
): { readonly span: SegmentSpan; readonly bounds: Bounds } | null {
  const sentences = new Sentences(segments);
  const anchor = anchorIn(segments, found, citedMs);
  if (segments[anchor]?.restricted) return null;
  let first = anchor;
  while (first > found.first && sentences.joins(first, first - 1)) first -= 1;
  let last = anchor;
  while (last < found.last && sentences.joins(last, last + 1)) last += 1;
  return {
    bounds: { first, last },
    span: {
      startMs:
        first === found.first ? span.startMs : (segments[first]?.startMs ?? 0),
      endMs: last === found.last ? span.endMs : (segments[last]?.endMs ?? 0),
    },
  };
}

/**
 * A cited passage grown to whole sentences with minimal context (KBC-156): from the start of
 * the cited segment's sentence to its end; then, under PASSAGE_MIN_MS and PASSAGE_MIN_WORDS,
 * the next whole sentence, else the previous; never past PASSAGE_MAX_MS, a change of voice, a
 * silence over PASSAGE_MAX_PAUSE_MS or a part the person may not hear. A saved span that
 * already runs across a change of voice or a part the person may not hear is first cut back
 * there, around the cited time (`citedMs`, default its start); otherwise it only grows, so the
 * cited time stays inside. A span on no segment, or cited on a restricted one, is left as it is.
 */
export function wholeSentences(
  segments: readonly SpokenSegment[],
  span: SegmentSpan,
  citedMs: number = span.startMs,
): SegmentSpan {
  const found = boundsOf(segments, span);
  const cut = found && clipped(segments, span, { found, citedMs });
  if (!cut) return { startMs: span.startMs, endMs: span.endMs };
  const sentences = new Sentences(segments);
  let bounds: Bounds = cut.bounds;
  for (let step = sentences.completeStep(bounds); step;) {
    bounds = step;
    step = sentences.completeStep(bounds);
  }
  while (!sentences.enough(bounds)) {
    const grown =
      sentences.nextSentence(bounds) ?? sentences.previousSentence(bounds);
    if (!grown) break;
    bounds = grown;
  }
  // Only grows past the cut: a span wider than its segments (an answer saved with other
  // times) keeps it.
  const grown = sentences.span(bounds);
  return {
    startMs: Math.min(cut.span.startMs, grown.startMs),
    endMs: Math.max(cut.span.endMs, grown.endMs),
  };
}
