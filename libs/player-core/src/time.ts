/** Clock and spoken time of the player (screens.md T15): tabular `m:ss` / `h:mm:ss`. */

const pad = (value: number): string => String(value).padStart(2, '0');

interface ClockParts {
  readonly hours: number;
  readonly minutes: number;
  readonly seconds: number;
}

/** Whole hours, minutes and seconds of a time in ms (floored; negatives count as 0). */
export function clockParts(ms: number): ClockParts {
  const total = Number.isFinite(ms) ? Math.max(0, Math.floor(ms / 1000)) : 0;
  return {
    hours: Math.floor(total / 3600),
    minutes: Math.floor((total % 3600) / 60),
    seconds: total % 60,
  };
}

/** `m:ss` under an hour, `h:mm:ss` from an hour on. */
export function formatClock(ms: number): string {
  const { hours, minutes, seconds } = clockParts(ms);
  return hours > 0
    ? `${hours}:${pad(minutes)}:${pad(seconds)}`
    : `${minutes}:${pad(seconds)}`;
}

/** Remaining time with a leading minus sign, as players show it (`-39:05`). */
export const formatRemaining = (
  currentMs: number,
  durationMs: number,
): string => `-${formatClock(Math.max(0, durationMs - currentMs))}`;

/** The words of a spoken time, given by the app's i18n (singular, plural). */
export interface SpokenUnits {
  readonly hour: readonly [string, string];
  readonly minute: readonly [string, string];
  readonly second: readonly [string, string];
  /** Joins the last two parts: "e". */
  readonly and: string;
}

const unit = (count: number, words: readonly [string, string]): string =>
  `${count} ${count === 1 ? words[0] : words[1]}`;

/** "1 hora, 2 minutos e 15 segundos"; zero parts are left out; 0 is "0 segundos". */
export function spokenTime(ms: number, words: SpokenUnits): string {
  const { hours, minutes, seconds } = clockParts(ms);
  const parts = [
    hours > 0 ? unit(hours, words.hour) : '',
    minutes > 0 ? unit(minutes, words.minute) : '',
    seconds > 0 ? unit(seconds, words.second) : '',
  ].filter((part) => part !== '');
  if (parts.length === 0) return unit(0, words.second);
  const last = parts.pop();
  return parts.length === 0
    ? `${last}`
    : `${parts.join(', ')} ${words.and} ${last}`;
}
