import { describe, expect, it } from 'vitest';
import { SlidingWindows } from './sliding-windows.js';

const MINUTE = 60_000;
const TEN_MINUTES = { max: 1, ms: 10 * MINUTE };
const FIVE_A_DAY = { max: 5, ms: 24 * 60 * MINUTE };

function setup() {
  let now = 1_000_000;
  return {
    windows: new SlidingWindows({ now: () => now }),
    advance: (ms: number) => (now += ms),
    at: () => now,
  };
}

describe('SlidingWindows', () => {
  it('refuses a second hit inside the window and says when the next one fits', () => {
    const { windows, advance, at } = setup();
    const key = { key: 'ana', windows: [TEN_MINUTES] };

    expect(windows.take([key])).toEqual({ allowed: true });
    const start = at();
    advance(3 * MINUTE);
    expect(windows.take([key])).toEqual({
      allowed: false,
      retryAt: start + 10 * MINUTE,
    });
    advance(7 * MINUTE);
    expect(windows.take([key])).toEqual({ allowed: true });
  });

  it('applies the longest window too: the sixth hit in a day waits for the first to age out', () => {
    const { windows, advance, at } = setup();
    const key = { key: 'ana', windows: [TEN_MINUTES, FIVE_A_DAY] };
    const first = at();
    for (let i = 0; i < 5; i += 1) {
      expect(windows.take([key]).allowed).toBe(true);
      advance(10 * MINUTE);
    }

    expect(windows.take([key])).toEqual({
      allowed: false,
      retryAt: first + 24 * 60 * MINUTE,
    });
  });

  it('counts nothing when any key is over its limit', () => {
    const { windows } = setup();
    const busy = { key: 'busy', windows: [TEN_MINUTES] };
    const free = { key: 'free', windows: [TEN_MINUTES] };
    windows.take([busy]);

    expect(windows.take([free, busy]).allowed).toBe(false);
    expect(windows.take([free]).allowed).toBe(true);
  });
});
