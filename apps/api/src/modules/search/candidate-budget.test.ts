import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  CANDIDATE_CAP,
  candidateLimit,
  deeperLimit,
  needsDeeper,
} from './candidate-budget.js';

describe('The adaptive candidate budget (KBC-103 FR-6, ADR 0036 §7)', () => {
  it('divides the base by the visible share, up to the cap', () => {
    expect(candidateLimit(60, 1)).toBe(60);
    expect(candidateLimit(60, 0.5)).toBe(120);
    expect(candidateLimit(60, 0.3)).toBe(200);
    expect(candidateLimit(200, 0.1)).toBe(CANDIDATE_CAP);
    expect(candidateLimit(60, 0.05)).toBe(CANDIDATE_CAP);
  });

  it('goes four times deeper once, never past the cap', () => {
    expect(deeperLimit(120)).toBe(480);
    expect(deeperLimit(400)).toBe(CANDIDATE_CAP);
  });

  it('asks deeper only for a short page from a full index below the cap', () => {
    const page = { visible: 10, base: 60, indexFull: true, limit: 120 };
    expect(needsDeeper(page)).toBe(true);
    expect(needsDeeper({ ...page, visible: 60 })).toBe(false);
    expect(needsDeeper({ ...page, indexFull: false })).toBe(false);
    expect(needsDeeper({ ...page, limit: CANDIDATE_CAP })).toBe(false);
  });

  it('never asks for less than the base nor more than the cap', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 500 }),
        fc.double({ min: 0.05, max: 1, noNaN: true }),
        (base, share) => {
          const limit = candidateLimit(base, share);
          expect(limit).toBeGreaterThanOrEqual(Math.min(base, CANDIDATE_CAP));
          expect(limit).toBeLessThanOrEqual(Math.max(base, CANDIDATE_CAP));
          expect(deeperLimit(limit)).toBeLessThanOrEqual(
            Math.max(limit, CANDIDATE_CAP),
          );
        },
      ),
    );
  });
});
