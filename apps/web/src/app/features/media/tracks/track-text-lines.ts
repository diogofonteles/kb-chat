import type { TranscriptSegment } from '@kb-chat/contracts';
import {
  lastStartedAt,
  type SpokenWord,
  type TimedSpan,
} from '@kb-chat/player-core';

/** One line of a track's text: a segment, or the part of it inside the track. */
export interface TextLine {
  readonly segment: number;
  /** The segment's own times: the lines stay in start order for `lastStartedAt`. */
  readonly startMs: number;
  readonly endMs: number;
  readonly text: string;
  /** Placed in `text`; empty without word times; null while their page is not here. */
  readonly words: readonly SpokenWord[] | null;
  /** In the whole transcript, whether the line belongs to the track (AC-18). */
  readonly inside: boolean;
}

/** A segment's words: empty without word times, null while their page is not here. */
export type WordsOf = (segment: number) => readonly SpokenWord[] | null;

/** What is painted: a word of a line, or a whole line without word times (BR-4). */
export interface Spoken {
  readonly line: number;
  readonly start: number;
  readonly end: number;
  readonly whole: boolean;
}

const crosses = (segment: TimedSpan, span: TimedSpan): boolean =>
  segment.startMs < span.endMs && segment.endMs > span.startMs;

/** The segments that cross the span, by index: a binary search, then a walk. */
function crossing(
  segments: readonly TranscriptSegment[],
  span: TimedSpan,
): number[] {
  const found: number[] = [];
  for (
    let index = Math.max(0, lastStartedAt(segments, span.startMs));
    index < segments.length;
    index++
  ) {
    const segment = segments[index];
    if (!segment || segment.startMs >= span.endMs) break;
    if (crosses(segment, span)) found.push(index);
  }
  return found;
}

/**
 * The text of a track (BR-1): a word belongs to the track where it starts, so the edge
 * segments are cut at their first and last such word, with the words' places moved to the
 * cut. A segment without word times, or whose words have not come yet, enters whole.
 */
export function trackLines(
  segments: readonly TranscriptSegment[],
  wordsOf: WordsOf,
  span: TimedSpan,
): TextLine[] {
  return crossing(segments, span).flatMap((index) => {
    const segment = segments[index];
    if (!segment) return [];
    const whole = { ...lineOf(segment, index, wordsOf(index)), inside: true };
    const line = cut(whole, span);
    return line ? [line] : [];
  });
}

/** A line's part inside the track; null when none of its words starts there. */
function cut(whole: TextLine, span: TimedSpan): TextLine | null {
  const { words } = whole;
  if (words === null || words.length === 0) return whole;
  const kept = words.filter(
    (word) => word.startMs >= span.startMs && word.startMs < span.endMs,
  );
  const first = kept[0];
  const last = kept.at(-1);
  if (!first || !last) return null;
  if (kept.length === words.length) return whole;
  const from = first.charStart;
  return {
    ...whole,
    text: whole.text.slice(from, last.charEnd),
    words: kept.map((word) => ({
      ...word,
      charStart: word.charStart - from,
      charEnd: word.charEnd - from,
    })),
  };
}

/** The whole transcript, uncut, with the track's segments marked (AC-18). */
export function wholeLines(
  segments: readonly TranscriptSegment[],
  wordsOf: WordsOf,
  span: TimedSpan,
): TextLine[] {
  return segments.map((segment, index) => ({
    ...lineOf(segment, index, wordsOf(index)),
    inside: crosses(segment, span),
  }));
}

function lineOf(
  segment: TranscriptSegment,
  index: number,
  words: readonly SpokenWord[] | null,
): Omit<TextLine, 'inside'> {
  return {
    segment: index,
    startMs: segment.startMs,
    endMs: segment.endMs,
    text: segment.text,
    words,
  };
}

/**
 * The word being said (BR-2): the last one of the track started at `ms`; in a silence the
 * one before stays, even from the line before. Outside the track nothing is. A line
 * without word times is painted whole while it plays (BR-4).
 */
export function spokenAt(
  lines: readonly TextLine[],
  span: TimedSpan,
  ms: number | null,
): Spoken | null {
  if (ms === null || ms < span.startMs || ms >= span.endMs) return null;
  for (let index = lastStartedAt(lines, ms); index >= 0; index--) {
    const line = lines[index];
    if (!line) return null;
    const { words } = line;
    if (words === null || words.length === 0)
      return ms < line.endMs
        ? { line: index, start: 0, end: line.text.length, whole: true }
        : null;
    const word = words[lastStartedAt(words, ms)];
    if (word)
      return word.startMs >= span.startMs
        ? {
            line: index,
            start: word.charStart,
            end: word.charEnd,
            whole: false,
          }
        : null;
  }
  return null;
}

/** Same painting: what depends on it runs only when the word changes (NFR-2). */
export const sameSpoken = (a: Spoken | null, b: Spoken | null): boolean =>
  a === b ||
  (a !== null &&
    b !== null &&
    a.line === b.line &&
    a.start === b.start &&
    a.end === b.end &&
    a.whole === b.whole);

/**
 * The segments whose words the track needs (FR-3): its two edges, to cut them, and the one
 * playing inside it, to paint the word. The rest of the track is whole segments.
 */
export function neededSegments(
  segments: readonly TranscriptSegment[],
  span: TimedSpan,
  ms: number | null,
): number[] {
  const inside = crossing(segments, span);
  const first = inside[0];
  const last = inside.at(-1);
  if (first === undefined || last === undefined) return [];
  const needed = new Set([first, last]);
  if (ms !== null && ms >= span.startMs && ms < span.endMs) {
    const playing = lastStartedAt(segments, ms);
    if (playing >= first) needed.add(playing);
  }
  return [...needed];
}
