import { describe, expect, it } from 'vitest';
import { AppError } from '../../app-error.js';
import { normalizeSilences } from './silence-map.js';

describe('normalizeSilences (KBC-044)', () => {
  it('sorts the pauses and merges the ones that overlap or touch', () => {
    expect(
      normalizeSilences(
        [
          { startMs: 5_000, endMs: 7_000 },
          { startMs: 1_000, endMs: 2_500 },
          { startMs: 2_500, endMs: 3_000 },
          { startMs: 6_000, endMs: 8_000 },
        ],
        10_000,
      ),
    ).toEqual([
      { startMs: 1_000, endMs: 3_000 },
      { startMs: 5_000, endMs: 8_000 },
    ]);
  });

  it('clips a pause that runs a little past the end to the media length', () => {
    expect(
      normalizeSilences([{ startMs: 9_000, endMs: 10_500 }], 10_000),
    ).toEqual([{ startMs: 9_000, endMs: 10_000 }]);
  });

  it('refuses a pause beyond the end of the media (a map of another file)', () => {
    expect(() =>
      normalizeSilences([{ startMs: 12_000, endMs: 13_000 }], 10_000),
    ).toThrow(AppError);
    expect(() =>
      normalizeSilences([{ startMs: 9_000, endMs: 13_000 }], 10_000),
    ).toThrow(/ends after the end/);
  });

  it('keeps the pauses as sent when the length is unknown', () => {
    expect(normalizeSilences([{ startMs: 1, endMs: 2 }], null)).toEqual([
      { startMs: 1, endMs: 2 },
    ]);
  });
});
