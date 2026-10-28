import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  SLIDER_PAGE_STEP_MS,
  SLIDER_SHIFT_STEP_MS,
  SLIDER_STEP_MS,
  applySliderMove,
  fractionOf,
  positionAtFraction,
  skipBy,
  sliderMoveOf,
} from './seek.js';

describe('sliderMoveOf', () => {
  it.each([
    ['ArrowRight', false, SLIDER_STEP_MS],
    ['ArrowUp', false, SLIDER_STEP_MS],
    ['ArrowLeft', false, -SLIDER_STEP_MS],
    ['ArrowDown', false, -SLIDER_STEP_MS],
    ['ArrowRight', true, SLIDER_SHIFT_STEP_MS],
    ['ArrowLeft', true, -SLIDER_SHIFT_STEP_MS],
    ['PageUp', false, SLIDER_PAGE_STEP_MS],
    ['PageDown', false, -SLIDER_PAGE_STEP_MS],
    ['PageUp', true, SLIDER_PAGE_STEP_MS],
  ])('%s (shift %s) moves by %i ms', (key, shift, delta) => {
    expect(sliderMoveOf(key, shift)).toEqual({ kind: 'by', deltaMs: delta });
  });

  it('jumps to the start and the end with Home and End', () => {
    expect(sliderMoveOf('Home', false)).toEqual({ kind: 'to', edge: 'start' });
    expect(sliderMoveOf('End', true)).toEqual({ kind: 'to', edge: 'end' });
  });

  it('leaves every other key to the page', () => {
    expect(sliderMoveOf('k', false)).toBeNull();
    expect(sliderMoveOf(' ', false)).toBeNull();
    expect(sliderMoveOf('Tab', false)).toBeNull();
  });

  it('uses 5 s, 10 s with shift, 60 s per page (AC-11: three → and End)', () => {
    const position = { currentMs: 0, durationMs: 600_000 };
    let at = 0;
    for (let i = 0; i < 3; i++) {
      const move = sliderMoveOf('ArrowRight', false);
      if (move) at = applySliderMove(move, { ...position, currentMs: at });
    }
    expect(at).toBe(15_000);
    const end = sliderMoveOf('End', false);
    expect(end && applySliderMove(end, position)).toBe(600_000);
  });
});

describe('applySliderMove', () => {
  it('never leaves the media', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 10_000_000 }),
        fc.integer({ min: 1, max: 10_000_000 }),
        fc.integer({ min: -1_000_000, max: 1_000_000 }),
        (current, duration, delta) => {
          const at = applySliderMove(
            { kind: 'by', deltaMs: delta },
            { currentMs: Math.min(current, duration), durationMs: duration },
          );
          expect(at).toBeGreaterThanOrEqual(0);
          expect(at).toBeLessThanOrEqual(duration);
        },
      ),
    );
  });

  it('goes to 0 with Home', () => {
    expect(
      applySliderMove(
        { kind: 'to', edge: 'start' },
        { currentMs: 9, durationMs: 10 },
      ),
    ).toBe(0);
  });
});

describe('skipBy', () => {
  it('skips forward 30 s and back 15 s without passing the edges (AC-10)', () => {
    expect(skipBy(0, 30_000, 10_000)).toBe(10_000);
    expect(skipBy(5_000, -15_000, 10_000)).toBe(0);
    expect(skipBy(60_000, -15_000, 600_000)).toBe(45_000);
    expect(skipBy(60_000, 30_000, null)).toBe(90_000);
  });
});

describe('positionAtFraction and fractionOf', () => {
  it('turns a click fraction into a position and back', () => {
    expect(positionAtFraction(0.5, 3_600_000)).toBe(1_800_000);
    expect(positionAtFraction(-1, 1_000)).toBe(0);
    expect(positionAtFraction(2, 1_000)).toBe(1_000);
    expect(positionAtFraction(Number.NaN, 1_000)).toBe(0);
    expect(fractionOf(1_800_000, 3_600_000)).toBe(0.5);
    expect(fractionOf(10, null)).toBe(0);
    expect(fractionOf(10, 0)).toBe(0);
    expect(fractionOf(5, -10)).toBe(0);
    expect(fractionOf(20, 10)).toBe(1);
    expect(fractionOf(-5, 10)).toBe(0);
  });

  it('round-trips within one millisecond', () => {
    fc.assert(
      fc.property(
        fc.double({ min: 0, max: 1, noNaN: true }),
        fc.integer({ min: 1, max: 20_000_000 }),
        (fraction, duration) => {
          const at = positionAtFraction(fraction, duration);
          expect(
            Math.abs(fractionOf(at, duration) * duration - at),
          ).toBeLessThan(1);
        },
      ),
    );
  });
});
