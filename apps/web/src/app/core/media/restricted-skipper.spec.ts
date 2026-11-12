import { nextRestricted, restrictedAt } from './restricted-skipper.js';

const SPANS = [
  { startMs: 60_000, endMs: 120_000 },
  { startMs: 300_000, endMs: 330_000 },
];

describe('restricted parts (KBC-106 FR-5)', () => {
  it('finds the part a position is in, or about to enter', () => {
    expect(restrictedAt(SPANS, 59_950)).toEqual(SPANS[0]);
    expect(restrictedAt(SPANS, 90_000)).toEqual(SPANS[0]);
    expect(restrictedAt(SPANS, 120_000)).toBeNull();
    expect(restrictedAt(SPANS, 30_000)).toBeNull();
    expect(restrictedAt([], 90_000)).toBeNull();
  });

  it('names the next part ahead', () => {
    expect(nextRestricted(SPANS, 0)).toEqual(SPANS[0]);
    expect(nextRestricted(SPANS, 120_000)).toEqual(SPANS[1]);
    expect(nextRestricted(SPANS, 330_000)).toBeNull();
  });
});
