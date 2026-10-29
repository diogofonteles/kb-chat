/** The sleep timer's lengths, in minutes (screens.md T15, KBC-046). */
export const SLEEP_MINUTES = [5, 10, 15, 30, 45, 60] as const;
export type SleepMinutes = (typeof SLEEP_MINUTES)[number];

/** The sound goes down over this last stretch (FR-2). */
export const FADE_MS = 10_000;
/** "Mais 5 minutos" (FR-3). */
export const EXTEND_MS = 5 * 60_000;

export type SleepTimer =
  | { readonly kind: 'off' }
  | { readonly kind: 'minutes'; readonly remainingMs: number }
  | { readonly kind: 'end-of-media' };

export const TIMER_OFF: SleepTimer = { kind: 'off' };

export function startTimer(choice: SleepMinutes | 'end-of-media'): SleepTimer {
  return choice === 'end-of-media'
    ? { kind: 'end-of-media' }
    : { kind: 'minutes', remainingMs: choice * 60_000 };
}

/** Real time that passed: it counts only while the media plays (BR-1). */
export function advanceTimer(
  timer: SleepTimer,
  realElapsedMs: number,
  playing: boolean,
): SleepTimer {
  if (timer.kind !== 'minutes' || !playing) return timer;
  return {
    kind: 'minutes',
    remainingMs: Math.max(0, timer.remainingMs - realElapsedMs),
  };
}

export function extendTimer(timer: SleepTimer): SleepTimer {
  return timer.kind === 'minutes'
    ? { kind: 'minutes', remainingMs: timer.remainingMs + EXTEND_MS }
    : timer;
}

/** How loud, from 1 to 0, over the last 10 s of a timed sleep. */
export function fadeFactor(timer: SleepTimer): number {
  if (timer.kind !== 'minutes') return 1;
  return Math.min(1, timer.remainingMs / FADE_MS);
}
