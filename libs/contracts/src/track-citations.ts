import { z } from 'zod';
import { transcriptConfidenceSchema } from './media.js';

/*
 * A track as a document of the collection (KBC-099, ADR 0035): its paragraphs start with a
 * time anchor on the track's own clock ("[0:41]", "[1:02:03]"), and the agent cites a
 * passage as "[n@m:ss]". The milliseconds always come from media.db, never from the text.
 */

/** "m:ss" or "h:mm:ss" (the hours with no padding, the rest with two digits). */
const CLOCK = String.raw`(?:\d{1,3}:)?\d{1,3}:\d{2}`;

/** One anchor at the start of a document paragraph, e.g. "[0:41]". */
export const TRACK_ANCHOR = new RegExp(String.raw`\[(${CLOCK})\]`, 'g');

/** A citation of a source, plain "[3]" or with a passage "[3@8:15]". */
export const SOURCE_CITATION = new RegExp(
  String.raw`\[(\d{1,4})(?:@(${CLOCK}))?\]`,
  'g',
);

/** The clock of `ms` on a track, whole seconds rounded down: "0:41", "1:02:03". */
export function formatTrackClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const pad = (value: number) => String(value).padStart(2, '0');
  return hours > 0
    ? `${hours}:${pad(minutes)}:${pad(seconds)}`
    : `${minutes}:${pad(seconds)}`;
}

/**
 * The seconds a clock names, or null when it is not one ("7:77" has no 77th second): the
 * agent may write any time, only a real one can match an anchor.
 */
export function clockSeconds(clock: string): number | null {
  const parts = clock.split(':').map(Number);
  if (parts.length < 2 || parts.length > 3) return null;
  if (parts.some((part) => !Number.isInteger(part) || part < 0)) return null;
  const [seconds = 0, minutes = 0, hours = 0] = [...parts].reverse();
  if (seconds > 59 || (parts.length === 3 && minutes > 59)) return null;
  return hours * 3600 + minutes * 60 + seconds;
}

/** The anchors written in a text, in order, as seconds on the track's clock. */
export function anchorsIn(text: string): number[] {
  return [...text.matchAll(new RegExp(TRACK_ANCHOR.source, 'g'))]
    .map((match) => clockSeconds(match[1] ?? ''))
    .filter((seconds): seconds is number => seconds !== null);
}

/**
 * The anchor of the paragraph `offset` falls in: the last one at or before it in the body,
 * or null before the first (the title and the recording line).
 */
export function anchorAt(body: string, offset: number): number | null {
  let found: number | null = null;
  for (const match of body.matchAll(new RegExp(TRACK_ANCHOR.source, 'g'))) {
    if (match.index > offset) break;
    found = clockSeconds(match[1] ?? '') ?? found;
  }
  return found;
}

/** A segment's span on the track's clock, in milliseconds. */
export interface SegmentSpan {
  readonly startMs: number;
  readonly endMs: number;
}

const spanOf = ({ startMs, endMs }: SegmentSpan): SegmentSpan => ({
  startMs,
  endMs,
});

/**
 * The media.db segment a second of the track names: the one that starts in that second (an
 * anchor is its paragraph's start, rounded down), else the one that holds it, else the next
 * one; past the end, the last. Without a second, the first segment (the track's start).
 */
export function snapToSegment(
  segments: readonly SegmentSpan[],
  seconds: number | null,
): SegmentSpan {
  const ms = (seconds ?? 0) * 1000;
  const first = segments[0];
  if (!first) return { startMs: ms, endMs: ms };
  if (seconds === null) return spanOf(first);
  const found =
    segments.find((one) => Math.floor(one.startMs / 1000) === seconds) ??
    segments.find((one) => one.startMs <= ms && ms < one.endMs) ??
    segments.find((one) => one.startMs >= ms) ??
    segments.at(-1) ??
    first;
  return spanOf(found);
}

/** Where a cited passage is on the track's clock, exact from media.db (ADR 0035 §6). */
export const trackPassageSchema = z.object({
  /** The time as the answer wrote it ("0:41"); empty for a plain "[n]". */
  at: z.string().max(16),
  startMs: z.number().int().min(0),
  endMs: z.number().int().min(0),
});
export type TrackPassage = z.infer<typeof trackPassageSchema>;

/** The track behind a cited source: what the chip and the panel show (T22). */
export const answerMediaSchema = z.object({
  mediaId: z.uuid(),
  kind: z.enum(['track', 'recording']),
  recordingTitle: z.string(),
  ordinal: z.number().int().min(1).optional(),
  total: z.number().int().min(1).optional(),
  durationMs: z.number().int().min(0),
  confidence: transcriptConfidenceSchema,
});
export type AnswerMedia = z.infer<typeof answerMediaSchema>;
