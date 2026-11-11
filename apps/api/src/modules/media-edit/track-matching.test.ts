import { describe, expect, it } from 'vitest';
import { matchTracks } from './track-matching.js';

const old = (mediaId: string, startMs: number, endMs: number) => ({
  mediaId,
  startMs,
  endMs,
});
const track = (id: string, startMs: number, endMs: number) => ({
  id,
  startMs,
  endMs,
});

describe('matchTracks (KBC-068 BR-5)', () => {
  it('keeps the item when the new track covers exactly 70 % of the old one', () => {
    const kept = matchTracks([old('a', 0, 100_000)], [track('n', 0, 70_000)]);
    expect(kept.get('n')).toBe('a');
  });

  it('gives the item up below 70 %', () => {
    const kept = matchTracks([old('a', 0, 100_000)], [track('n', 0, 69_999)]);
    expect(kept.size).toBe(0);
  });

  it('leaves a split with its larger part', () => {
    const kept = matchTracks(
      [old('a', 0, 100_000)],
      [track('small', 0, 25_000), track('large', 25_000, 100_000)],
    );
    expect([...kept]).toEqual([['large', 'a']]);
  });

  it('leaves a join with the track it covers most, one to one', () => {
    const kept = matchTracks(
      [old('a', 0, 40_000), old('b', 40_000, 100_000)],
      [track('joined', 0, 100_000)],
    );
    expect([...kept]).toEqual([['joined', 'b']]);
  });

  it('never gives an item to a track that does not touch it', () => {
    expect(
      matchTracks([old('a', 0, 10_000)], [track('n', 20_000, 30_000)]).size,
    ).toBe(0);
  });
});
