import { describe, expect, it } from 'vitest';
import { spanAround } from './word-span.js';

const at = (...positions: number[]) =>
  positions.map((position) => ({ position }));

describe('spanAround (KBC-115 BR-1)', () => {
  it('runs from the anchor to the focus, either way', () => {
    const words = at(10, 11, 12, 13);
    expect(spanAround(words, 1, 3)).toEqual({
      first: 1,
      last: 3,
      clamped: false,
    });
    expect(spanAround(words, 3, 0)).toEqual({
      first: 0,
      last: 3,
      clamped: false,
    });
    expect(spanAround(words, 2, 2)).toEqual({
      first: 2,
      last: 2,
      clamped: false,
    });
  });

  it('stops at the fifth word counted from the anchor, and says so', () => {
    const words = at(0, 1, 2, 3, 4, 5, 6);
    expect(spanAround(words, 0, 6)).toEqual({
      first: 0,
      last: 4,
      clamped: true,
    });
    expect(spanAround(words, 6, 0)).toEqual({
      first: 2,
      last: 6,
      clamped: true,
    });
  });

  it('counts places, not words with text: a gap of emptied words counts too', () => {
    const words = at(0, 1, 5);
    expect(spanAround(words, 0, 2)).toEqual({
      first: 0,
      last: 1,
      clamped: true,
    });
  });
});
