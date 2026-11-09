import type {
  DerivedSegment,
  DerivedWord,
} from '../../ports/transcript-store.js';

/** The part of a recording a track holds, in real times. */
export interface TrackWindow {
  readonly startMs: number;
  readonly endMs: number;
}

export interface TranscriptSlice {
  readonly segments: readonly DerivedSegment[];
  readonly words: readonly DerivedWord[];
}

const midpointOf = (item: { startMs: number; endMs: number }): number =>
  (item.startMs + item.endMs) / 2;

/** KBC-068's rule: a word or segment belongs where its midpoint falls. */
export const holds = (
  window: TrackWindow,
  item: { startMs: number; endMs: number },
) =>
  midpointOf(item) >= window.startMs && midpointOf(item) < window.endMs;

/** Times from the start of the track, never outside it. */
const shifted = <T extends { startMs: number; endMs: number }>(
  item: T,
  window: TrackWindow,
): T => {
  const length = window.endMs - window.startMs;
  const clamp = (ms: number) =>
    Math.max(0, Math.min(length, ms - window.startMs));
  return { ...item, startMs: clamp(item.startMs), endMs: clamp(item.endMs) };
};

/** A segment cut by the window says only the words that stayed. */
const textOf = (
  segment: DerivedSegment,
  all: readonly DerivedWord[],
  kept: readonly DerivedWord[],
): string =>
  kept.length === all.length
    ? segment.text
    : kept
        .map((word) => word.text.trim())
        // A word a correction emptied is not said (KBC-093 BR-2).
        .filter((text) => text !== '')
        .join(' ');

/**
 * The transcript inside a track (KBC-068 FR-3, BR-4): a word belongs where its midpoint
 * falls, a segment with words keeps those, one without words goes by its own midpoint. Word
 * and segment times start at the track's start; the search index rows follow the segments.
 */
export function sliceTranscript(
  transcript: TranscriptSlice,
  window: TrackWindow,
): TranscriptSlice {
  const segments: DerivedSegment[] = [];
  const words: DerivedWord[] = [];
  transcript.segments.forEach((segment, index) => {
    const all = transcript.words.filter((word) => word.segment === index);
    const kept = all.filter((word) => holds(window, word));
    if (all.length > 0 ? kept.length === 0 : !holds(window, segment)) return;
    const position = segments.length;
    segments.push({
      ...shifted(segment, window),
      text: textOf(segment, all, kept),
    });
    for (const word of kept)
      words.push({ ...shifted(word, window), segment: position });
  });
  return { segments, words };
}
