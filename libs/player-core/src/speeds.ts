/** The playback speeds of the speed menu (screens.md T15, KBC-041 FR-1). */
export const SPEEDS = [0.75, 1, 1.25, 1.5, 1.75, 2] as const;
export type PlaybackSpeed = (typeof SPEEDS)[number];

export const DEFAULT_SPEED: PlaybackSpeed = 1;

export function isSpeed(value: number): value is PlaybackSpeed {
  return (SPEEDS as readonly number[]).includes(value);
}

/** One step up or down the menu, stopping at its ends (no wrapping around, FR-5). */
export function stepSpeed(
  current: PlaybackSpeed,
  direction: 1 | -1,
): PlaybackSpeed {
  const at = SPEEDS.indexOf(current);
  const next = Math.min(SPEEDS.length - 1, Math.max(0, at + direction));
  return SPEEDS[next] ?? current;
}
