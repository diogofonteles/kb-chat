import type {
  MediaTranscript,
  TrackPassage,
  TranscriptSegment,
} from '@kb-chat/contracts';
import { speakerChanges, type SpeakerShown } from '../voices/speaker-names.js';

/** Who speaks a line: the name and the voice, for its colour (KBC-065). */
export type LineSpeaker = SpeakerShown & { readonly voice: number };

/** One line of "Em volta do trecho" (KBC-150): the speech before, the passage, the next one. */
export interface ContextLine {
  readonly kind: 'before' | 'cited' | 'after';
  readonly startMs: number;
  readonly endMs: number;
  readonly text: string;
  readonly speaker: LineSpeaker | null;
}

/** The segments a passage falls on, by index (first and last); null when none. */
export function citedRange(
  segments: readonly TranscriptSegment[],
  passage: Pick<TrackPassage, 'startMs' | 'endMs'>,
): { readonly first: number; readonly last: number } | null {
  let first = -1;
  let last = -1;
  segments.forEach((one, index) => {
    if (one.startMs < passage.endMs && one.endMs > passage.startMs) {
      if (first < 0) first = index;
      last = index;
    }
  });
  return first < 0 ? null : { first, last };
}

/**
 * Who speaks each segment, when the transcript says it (only for who may see the voices,
 * KBC-064/065): the last change of speaker at or before it. Empty without voices.
 */
export function speakersBySegment(
  transcript: MediaTranscript,
): readonly (LineSpeaker | null)[] {
  const voiced = transcript.segments.some(
    (one) => one.voice !== undefined && one.voice !== null,
  );
  if (!voiced) return [];
  const changes = speakerChanges(transcript);
  let current: LineSpeaker | null = null;
  return transcript.segments.map((one, index) => {
    if (one.voice === null || one.voice === undefined) current = null;
    current = changes.get(index) ?? current;
    return current;
  });
}

/** The nearest readable segment from `index` in `step` direction (restricted ones skipped). */
function readable(
  segments: readonly TranscriptSegment[],
  index: number,
  step: 1 | -1,
): number {
  let at = index;
  while (at >= 0 && at < segments.length && segments[at]?.restricted)
    at += step;
  return at >= 0 && at < segments.length ? at : -1;
}

/** One segment as a line of "Em volta do trecho"; none for a missing one. */
const lineOf = (
  one: TranscriptSegment | undefined,
  speaker: LineSpeaker | null | undefined,
  kind: 'before' | 'after',
): ContextLine[] =>
  one
    ? [
        {
          kind,
          startMs: one.startMs,
          endMs: one.endMs,
          text: one.text,
          speaker: speaker ?? null,
        },
      ]
    : [];

/** The passage's segments as one line, the restricted ones left out of its text. */
const citedLine = (
  cited: readonly TranscriptSegment[],
  passage: Pick<TrackPassage, 'startMs' | 'endMs'>,
  speaker: LineSpeaker | null,
): ContextLine => ({
  kind: 'cited',
  startMs: cited[0]?.startMs ?? passage.startMs,
  endMs: cited.at(-1)?.endMs ?? passage.endMs,
  text: cited
    .filter((one) => !one.restricted)
    .map((one) => one.text.trim())
    .join(' '),
  speaker,
});

/**
 * Only the speech before the passage, the passage (its segments as one line) and the speech
 * after it (KBC-150 item 5).
 */
export function aroundPassage(
  transcript: MediaTranscript,
  passage: Pick<TrackPassage, 'startMs' | 'endMs'>,
): ContextLine[] {
  const { segments } = transcript;
  const range = citedRange(segments, passage);
  if (!range) return [];
  const speakers = speakersBySegment(transcript);
  const before = readable(segments, range.first - 1, -1);
  const after = readable(segments, range.last + 1, 1);
  return [
    ...lineOf(segments[before], speakers[before], 'before'),
    citedLine(
      segments.slice(range.first, range.last + 1),
      passage,
      speakers[range.first] ?? null,
    ),
    ...lineOf(segments[after], speakers[after], 'after'),
  ];
}

/** A cited passage on the track's timeline, in percent of its length (KBC-150 item 4). */
export interface TimelineMark {
  readonly index: number;
  readonly startMs: number;
  readonly endMs: number;
  readonly left: number;
  readonly width: number;
}

const percentOf = (ms: number, durationMs: number): number =>
  durationMs > 0 ? Math.min(100, Math.max(0, (ms / durationMs) * 100)) : 0;

export function timelineMarks(
  passages: readonly TrackPassage[],
  durationMs: number,
): TimelineMark[] {
  return passages.map((one, index) => {
    const left = percentOf(one.startMs, durationMs);
    return {
      index,
      startMs: one.startMs,
      endMs: one.endMs,
      left,
      width: Math.max(0, percentOf(one.endMs, durationMs) - left),
    };
  });
}

/** Where the line heard now is, for "Em volta do trecho" while it plays (item 5). */
export function lineStateAt(
  line: Pick<ContextLine, 'startMs' | 'endMs'>,
  nowMs: number,
  playing: boolean,
): 'past' | 'now' | 'idle' {
  if (!playing) return 'idle';
  if (nowMs >= line.endMs) return 'past';
  return nowMs >= line.startMs ? 'now' : 'idle';
}
