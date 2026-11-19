import { describe, expect, it } from 'vitest';
import { tabTarget } from './research-thread.js';

describe('tabTarget (the reading sheet tabs, ARIA APG)', () => {
  it('moves right and left, wrapping at the ends', () => {
    expect(tabTarget('ArrowRight', 0, 3)).toBe(1);
    expect(tabTarget('ArrowRight', 2, 3)).toBe(0);
    expect(tabTarget('ArrowLeft', 0, 3)).toBe(2);
    expect(tabTarget('ArrowLeft', 2, 3)).toBe(1);
  });

  it('goes to the first with Home and the last with End', () => {
    expect(tabTarget('Home', 2, 3)).toBe(0);
    expect(tabTarget('End', 0, 3)).toBe(2);
  });

  it('ignores any other key', () => {
    expect(tabTarget('Enter', 1, 3)).toBeNull();
    expect(tabTarget('ArrowDown', 1, 3)).toBeNull();
  });
});
