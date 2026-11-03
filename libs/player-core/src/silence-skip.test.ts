import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  KEPT_EDGE_MS,
  SHORTEN_FROM_MS,
  delayUntil,
  nextSkipIndex,
  reachedSkip,
  skipAfterLanding,
  skipsOf,
} from './silence-skip.js';

const MAP = [
  { startMs: 1_000, endMs: 1_500 }, // 0.5 s: kept
  { startMs: 2_500, endMs: 3_700 }, // 1.2 s
  { startMs: 4_700, endMs: 7_700 }, // 3 s
];

describe('silence skipping (KBC-044)', () => {
  it('shortens only pauses of 1 s or more, keeping 0.15 s at each edge (BR-1)', () => {
    expect(SHORTEN_FROM_MS).toBe(1_000);
    expect(KEPT_EDGE_MS).toBe(150);
    expect(skipsOf(MAP)).toEqual([
      { startMs: 2_500, fromMs: 2_650, toMs: 3_550 },
      { startMs: 4_700, fromMs: 4_850, toMs: 7_550 },
    ]);
    expect(skipsOf([{ startMs: 0, endMs: 999 }])).toEqual([]);
    expect(skipsOf([{ startMs: 0, endMs: 1_000 }])).toEqual([
      { startMs: 0, fromMs: 150, toMs: 850 },
    ]);
  });

  it('arms the first skip ahead of the position, never one already behind (BR-3)', () => {
    const skips = skipsOf(MAP);
    expect(nextSkipIndex(skips, 0)).toBe(0);
    expect(nextSkipIndex(skips, 2_649)).toBe(0);
    // A jump that lands inside the 1.2 s pause: that pause is heard; the next is shortened.
    expect(nextSkipIndex(skips, 2_650)).toBe(1);
    expect(nextSkipIndex(skips, 3_000)).toBe(1);
    expect(nextSkipIndex(skips, 5_000)).toBe(-1);
    expect(nextSkipIndex([], 0)).toBe(-1);
  });

  it('after a landing, waits for the next pause even from the first 0.15 s of one (BR-3)', () => {
    const skips = skipsOf(MAP);
    expect(skipAfterLanding(skips, 2_499)).toBe(0);
    // Landing at 4.7–4.85 s: inside the 3 s pause, before its skip point; it is heard.
    expect(skipAfterLanding(skips, 2_500)).toBe(1);
    expect(skipAfterLanding(skips, 4_700)).toBe(-1);
    expect(skipAfterLanding(skips, 4_800)).toBe(-1);
    expect(skipAfterLanding(skips, 4_000)).toBe(1);
    expect(skipAfterLanding([], 0)).toBe(-1);
  });

  it('finds the same skip as a linear scan, for any map and position', () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 0, max: 100_000 }), { maxLength: 40 }),
        fc.integer({ min: 0, max: 110_000 }),
        (starts, position) => {
          const skips = [...new Set(starts)]
            .sort((a, b) => a - b)
            .map((start) => ({
              startMs: start,
              fromMs: start,
              toMs: start + 10,
            }));
          const linear = skips.findIndex((skip) => skip.fromMs > position);
          expect(nextSkipIndex(skips, position)).toBe(linear);
        },
      ),
    );
  });

  it('says when playing reached a skip, a timer a little early included', () => {
    const skip = { startMs: 4_700, fromMs: 4_850, toMs: 7_550 };
    expect(reachedSkip(skip, 4_820, 30)).toBe(true);
    expect(reachedSkip(skip, 4_819, 30)).toBe(false);
    expect(reachedSkip(skip, 7_549, 30)).toBe(true);
    expect(reachedSkip(skip, 7_550, 30)).toBe(false);
  });

  it('waits the real time the speed takes to reach the skip', () => {
    const skip = { startMs: 4_700, fromMs: 4_850, toMs: 7_550 };
    expect(delayUntil(skip, 3_850, 1)).toBe(1_000);
    expect(delayUntil(skip, 3_850, 2)).toBe(500);
    expect(delayUntil(skip, 5_000, 1)).toBe(0);
  });
});
