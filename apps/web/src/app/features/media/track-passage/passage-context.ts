import type {
  MediaTranscript,
  TrackPassage,
  TranscriptSegment,
} from '@kb-chat/contracts';
import { lastStartedAt } from '@kb-chat/player-core';
import { playbackStartOf } from '../search-hit/passage-focus.js';
import { speakerChanges, type SpeakerShown } from '../voices/speaker-names.js';

/** Who speaks a line: the name and the voice, for its colour (KBC-065). */
export type LineSpeaker = SpeakerShown & { readonly voice: number };

/**
 * One line of "Em volta do trecho" (KBC-150): the speech before, the passage, the next one;
 * while playback is past the passage, the speech heard between them (KBC-154).
 */
export interface ContextLine {
  readonly kind: 'before' | 'cited' | 'heard' | 'after';
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
 * Who speaks each segment, when the transcript says it (whoever may listen gets the voices
 * they hear, KBC-151 BR-0): the last change of speaker at or before it. Empty without voices.
 */
export function speakersBySegment(
  transcript: MediaTranscript,
): readonly (LineSpeaker | null)[] {
  const known = SPEAKERS.get(transcript);
  if (known) return known;
  const found = findSpeakers(transcript);
  SPEAKERS.set(transcript, found);
  return found;
}

/** Once per transcript: the lines around follow playback and ask on every tick (KBC-154). */
const SPEAKERS = new WeakMap<
  MediaTranscript,
  readonly (LineSpeaker | null)[]
>();

function findSpeakers(
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
  kind: Exclude<ContextLine['kind'], 'cited'>,
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
  range: CitedRange | null = citedRange(transcript.segments, passage),
): ContextLine[] {
  const { segments } = transcript;
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

/** The segments a passage falls on (first and last), as `citedRange` finds them. */
export type CitedRange = NonNullable<ReturnType<typeof citedRange>>;

/**
 * While the track plays outside the cited passage (KBC-154): the line heard at `nowMs` with
 * the one before and the one after, a cited segment among them still marked as cited. Null
 * while the passage's own lines already show what is heard: the passage itself, its 2 s
 * lead-in, or the line right before or after it; and when nothing readable is heard.
 */
export function aroundHeard(
  transcript: MediaTranscript,
  passage: Pick<TrackPassage, 'startMs' | 'endMs'>,
  {
    nowMs,
    range = citedRange(transcript.segments, passage),
  }: { readonly nowMs: number; readonly range?: CitedRange | null },
): ContextLine[] | null {
  if (nowMs >= playbackStartOf(passage) && nowMs < passage.endMs) return null;
  const { segments } = transcript;
  const heard = readable(segments, lastStartedAt(segments, nowMs), -1);
  if (heard < 0 || (range && aroundCited(segments, range, heard))) return null;
  const at = heardLineOf(transcript, passage, range);
  const before = readable(segments, heard - 1, -1);
  const after = readable(segments, heard + 1, 1);
  return [
    ...(before < 0 ? [] : at(before, 'before')),
    ...at(heard, 'heard'),
    ...(after < 0 ? [] : at(after, 'after')),
  ];
}

/** Whether `index` is among the passage's own lines: a cited segment or its readable neighbour. */
const aroundCited = (
  segments: readonly TranscriptSegment[],
  range: CitedRange,
  index: number,
): boolean =>
  (index >= range.first && index <= range.last) ||
  index === readable(segments, range.first - 1, -1) ||
  index === readable(segments, range.last + 1, 1);

/** A segment as a line around what is heard: a cited one keeps its kind (BR-2). */
function heardLineOf(
  transcript: MediaTranscript,
  passage: Pick<TrackPassage, 'startMs' | 'endMs'>,
  range: CitedRange | null,
) {
  const { segments } = transcript;
  const speakers = speakersBySegment(transcript);
  return (
    index: number,
    kind: Exclude<ContextLine['kind'], 'cited'>,
  ): ContextLine[] =>
    range !== null && index >= range.first && index <= range.last
      ? [
          citedLine(
            segments.slice(index, index + 1),
            passage,
            speakers[index] ?? null,
          ),
        ]
      : lineOf(segments[index], speakers[index], kind);
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
