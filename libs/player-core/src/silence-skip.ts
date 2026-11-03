/**
 * "Encurtar silêncios" (KBC-044, ADR 0025 §3): which part of each pause the player skips.
 * Pure rules over the media's silence map, in ms of the original timeline (FR-5).
 */

/** Only pauses this long or longer are shortened (BR-1). */
export const SHORTEN_FROM_MS = 1_000;
/** What is kept of a shortened pause at each edge: it lasts 0.3 s in all (BR-1). */
export const KEPT_EDGE_MS = 150;

/** A pause of the map. */
export interface Silence {
  readonly startMs: number;
  readonly endMs: number;
}

/** The part of a pause the player jumps over: from `fromMs` it seeks to `toMs`. */
export interface SilenceSkip {
  readonly fromMs: number;
  readonly toMs: number;
}

/** The skips of a map, in order: one per pause of 1 s or more (BR-1). */
export function skipsOf(silences: readonly Silence[]): SilenceSkip[] {
  return silences
    .filter((pause) => pause.endMs - pause.startMs >= SHORTEN_FROM_MS)
    .map((pause) => ({
      fromMs: pause.startMs + KEPT_EDGE_MS,
      toMs: pause.endMs - KEPT_EDGE_MS,
    }))
    .sort((a, b) => a.fromMs - b.fromMs);
}

/**
 * The first skip that starts after `positionMs` (index into `skips`), or -1. A skip whose
 * start is already behind is never armed: the player got there by a jump of the person
 * (bar, buttons, transcript, bookmark, `?t=`, resume), which is respected (BR-3).
 */
export function nextSkipIndex(
  skips: readonly SilenceSkip[],
  positionMs: number,
): number {
  let low = 0;
  let high = skips.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if ((skips[middle]?.fromMs ?? Infinity) <= positionMs) low = middle + 1;
    else high = middle;
  }
  return low < skips.length ? low : -1;
}

/**
 * Playing reached an armed skip: the position is at its start (or up to `earlyMs` before
 * it, a timer that fires a little early) and not yet past its end.
 */
export function reachedSkip(
  skip: SilenceSkip,
  positionMs: number,
  earlyMs: number,
): boolean {
  return positionMs >= skip.fromMs - earlyMs && positionMs < skip.toMs;
}

/** Real time until playing at `speed` reaches the skip's start (never negative). */
export function delayUntil(
  skip: SilenceSkip,
  positionMs: number,
  speed: number,
): number {
  return Math.max(0, (skip.fromMs - positionMs) / speed);
}
