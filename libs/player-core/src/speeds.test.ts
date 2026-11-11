import { describe, expect, it } from 'vitest';
import { DEFAULT_SPEED, SPEEDS, isSpeed, stepSpeed } from './speeds.js';

describe('speeds', () => {
  it('offers the six steps of T15, starting at 1×', () => {
    expect(SPEEDS).toEqual([0.75, 1, 1.25, 1.5, 1.75, 2]);
    expect(DEFAULT_SPEED).toBe(1);
  });

  it('accepts only those steps', () => {
    for (const speed of SPEEDS) expect(isSpeed(speed)).toBe(true);
    for (const other of [0, 0.5, 1.1, 2.5, 3, Number.NaN, -1])
      expect(isSpeed(other)).toBe(false);
  });

  it('goes up and down one step without wrapping around (FR-5)', () => {
    expect(stepSpeed(1, 1)).toBe(1.25);
    expect(stepSpeed(1.75, 1)).toBe(2);
    expect(stepSpeed(2, 1)).toBe(2);
    expect(stepSpeed(1, -1)).toBe(0.75);
    expect(stepSpeed(0.75, -1)).toBe(0.75);
  });
});
