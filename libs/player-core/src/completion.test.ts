import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { COMPLETION_RATIO, isCompleted, resumeFrom } from './completion.js';

describe('completion (BR-2)', () => {
  it('counts a media as heard from 95% of its length', () => {
    expect(COMPLETION_RATIO).toBe(0.95);
    expect(isCompleted(94_999, 100_000)).toBe(false);
    expect(isCompleted(95_000, 100_000)).toBe(true);
    expect(isCompleted(100_000, 100_000)).toBe(true);
    expect(isCompleted(120_000, 100_000)).toBe(true);
  });

  it('never counts one with no known length', () => {
    expect(isCompleted(10, 0)).toBe(false);
    expect(isCompleted(10, null)).toBe(false);
  });

  it('offers to continue only from a position before 95% (FR-4)', () => {
    expect(resumeFrom(0, 100_000)).toBeNull();
    expect(resumeFrom(1_390_000, 3_735_000)).toBe(1_390_000);
    expect(resumeFrom(95_000, 100_000)).toBeNull();
    expect(resumeFrom(5_000, null)).toBe(5_000);
  });

  it('never offers a position it also counts as heard', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 10_000_000 }),
        fc.integer({ min: 1, max: 10_000_000 }),
        (position, duration) => {
          if (resumeFrom(position, duration) !== null)
            expect(isCompleted(position, duration)).toBe(false);
        },
      ),
    );
  });
});
