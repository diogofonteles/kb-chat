import type { SilenceInterval } from '@kb-chat/contracts';
import { AppError } from '../../app-error.js';

/** A pause may end this far past the known length (ffprobe and ffmpeg round apart). */
const END_TOLERANCE_MS = 2_000;

const invalid = (reason: string) =>
  new AppError('VALIDATION_FAILED', `Invalid silence map: ${reason}`, {
    details: { field: 'intervals' },
  });

/**
 * The pauses as stored (FR-1): in order, overlaps merged, clipped to the media's length.
 * A pause that starts after the end means the map is of another file: refused.
 */
export function normalizeSilences(
  intervals: readonly SilenceInterval[],
  durationMs: number | null,
): SilenceInterval[] {
  const sorted = [...intervals].sort((a, b) => a.startMs - b.startMs);
  const merged: SilenceInterval[] = [];
  for (const interval of sorted) {
    if (durationMs !== null && interval.startMs >= durationMs)
      throw invalid('a pause starts after the end of the media');
    if (durationMs !== null && interval.endMs > durationMs + END_TOLERANCE_MS)
      throw invalid('a pause ends after the end of the media');
    const endMs =
      durationMs === null
        ? interval.endMs
        : Math.min(interval.endMs, durationMs);
    const last = merged.at(-1);
    if (last && interval.startMs <= last.endMs)
      merged[merged.length - 1] = {
        startMs: last.startMs,
        endMs: Math.max(last.endMs, endMs),
      };
    else merged.push({ startMs: interval.startMs, endMs });
  }
  return merged.filter((interval) => interval.endMs > interval.startMs);
}
