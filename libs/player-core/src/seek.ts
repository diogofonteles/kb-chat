import { clampToDuration } from './playback-state.js';

/** How far a key on the time slider moves (APG "Media Seek Slider", screens.md T15). */
export const SLIDER_STEP_MS = 5_000;
export const SLIDER_SHIFT_STEP_MS = 10_000;
export const SLIDER_PAGE_STEP_MS = 60_000;

export type SliderMove =
  | { readonly kind: 'by'; readonly deltaMs: number }
  | { readonly kind: 'to'; readonly edge: 'start' | 'end' };

const PLAIN_KEYS: Readonly<Record<string, number>> = {
  ArrowRight: SLIDER_STEP_MS,
  ArrowUp: SLIDER_STEP_MS,
  ArrowLeft: -SLIDER_STEP_MS,
  ArrowDown: -SLIDER_STEP_MS,
  PageUp: SLIDER_PAGE_STEP_MS,
  PageDown: -SLIDER_PAGE_STEP_MS,
};

/** What a key does on the focused time slider; null when the slider does not use it. */
export function sliderMoveOf(
  key: string,
  shiftKey: boolean,
): SliderMove | null {
  if (key === 'Home') return { kind: 'to', edge: 'start' };
  if (key === 'End') return { kind: 'to', edge: 'end' };
  const step = PLAIN_KEYS[key];
  if (step === undefined) return null;
  const isArrow = key.startsWith('Arrow');
  const deltaMs =
    shiftKey && isArrow ? Math.sign(step) * SLIDER_SHIFT_STEP_MS : step;
  return { kind: 'by', deltaMs };
}

/** The position a slider move leads to, inside the media. */
export function applySliderMove(
  move: SliderMove,
  position: { readonly currentMs: number; readonly durationMs: number },
): number {
  if (move.kind === 'to')
    return move.edge === 'start' ? 0 : position.durationMs;
  return clampToDuration(
    position.currentMs + move.deltaMs,
    position.durationMs,
  );
}

/** Skipping back or forward never passes the start or the end. */
export const skipBy = (
  currentMs: number,
  deltaMs: number,
  durationMs: number | null,
): number => clampToDuration(currentMs + deltaMs, durationMs);

/** The position at a fraction (0–1) of the track, e.g. a click on the slider. */
export function positionAtFraction(
  fraction: number,
  durationMs: number,
): number {
  const bounded = Math.min(
    1,
    Math.max(0, Number.isFinite(fraction) ? fraction : 0),
  );
  return Math.round(bounded * durationMs);
}

/** The fraction (0–1) of the track a position is at; 0 without a duration. */
export function fractionOf(ms: number, durationMs: number | null): number {
  const total = durationMs ?? 0;
  if (!(total > 0)) return 0;
  return Math.min(1, Math.max(0, ms / total));
}
