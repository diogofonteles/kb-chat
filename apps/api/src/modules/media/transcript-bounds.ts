import type { RawTranscript } from '@kb-chat/contracts';
import { AppError } from '../../app-error.js';

/** A track's speech never passes this many words per second (fast speech is ~4). */
const MAX_WORDS_PER_SECOND = 20;
/** Room for a short track and whisper's timestamps past the last sample. */
const SLACK_WORDS = 2_000;
const SLACK_SECONDS = 30;

const refuse = (message: string) =>
  new AppError('VALIDATION_FAILED', message, { details: { field: 'raw' } });

/** Every chunk, segment and word time on the track's clock, in seconds. */
const timesOf = (raw: RawTranscript): number[] =>
  raw.chunks.flatMap((chunk) => [
    chunk.offset,
    chunk.end,
    ...chunk.result.segments.flatMap((segment) => [
      segment.start + chunk.offset,
      segment.end + chunk.offset,
      ...(segment.words ?? []).map((word) => word.end + chunk.offset),
    ]),
  ]);

const wordCountOf = (raw: RawTranscript): number =>
  raw.chunks.reduce(
    (sum, chunk) =>
      chunk.result.segments.reduce(
        (inner, segment) => inner + (segment.words?.length ?? 0),
        sum,
      ),
    0,
  );

/**
 * A raw result the media it belongs to could have produced (the worker is outside the
 * API's trust): times within the track and a word count speech can reach. Unknown length
 * (an item converted before durations were kept) checks the words only against the slack.
 */
export function assertPlausible(
  raw: RawTranscript,
  durationMs: number | null,
): void {
  const seconds = (durationMs ?? 0) / 1000;
  const maxWords = MAX_WORDS_PER_SECOND * seconds + SLACK_WORDS;
  if (wordCountOf(raw) > maxWords)
    throw refuse('More words than the audio can hold');
  if (durationMs === null) return;
  const last = seconds + SLACK_SECONDS;
  for (const time of timesOf(raw))
    if (time < 0 || time > last) throw refuse('A time falls outside the audio');
}
