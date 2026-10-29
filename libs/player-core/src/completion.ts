/** From this share of its length a media counts as heard and its position resets (BR-2). */
export const COMPLETION_RATIO = 0.95;

export function isCompleted(
  positionMs: number,
  durationMs: number | null,
): boolean {
  return (
    durationMs !== null &&
    durationMs > 0 &&
    positionMs >= durationMs * COMPLETION_RATIO
  );
}

/** The position "Continuar de" offers (FR-4): a saved one, not yet heard; else null. */
export function resumeFrom(
  positionMs: number,
  durationMs: number | null,
): number | null {
  return positionMs > 0 && !isCompleted(positionMs, durationMs)
    ? positionMs
    : null;
}
