import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { REFRESH_DELAY_MS, refreshSoon } from './refresh-soon.js';

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('refreshSoon (KBC-009 R2)', () => {
  it('reads a collection once after several documents, and again for later ones', async () => {
    const read: string[] = [];
    const soon = refreshSoon(
      (topic) => {
        read.push(topic);
        return Promise.resolve();
      },
      { onError: () => undefined },
    );
    soon('a');
    soon('a');
    soon('b');
    expect(read).toEqual([]);
    await vi.advanceTimersByTimeAsync(REFRESH_DELAY_MS);
    expect(read).toEqual(['a', 'b']);
    soon('a');
    await vi.advanceTimersByTimeAsync(REFRESH_DELAY_MS);
    expect(read).toEqual(['a', 'b', 'a']);
  });

  it('a reading that fails is told, never thrown', async () => {
    const errors: unknown[] = [];
    const soon = refreshSoon(() => Promise.reject(new Error('no vault')), {
      onError: (err) => errors.push(err),
    });
    soon('a');
    await vi.advanceTimersByTimeAsync(REFRESH_DELAY_MS);
    expect(errors).toHaveLength(1);
  });
});
