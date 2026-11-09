import type { LocalTranscriberStart } from '@kb-chat/contracts';
import { describe, expect, it } from 'vitest';
import { TranscriberWaker } from './transcriber-waker.js';

/** A Mac whose launchctl only counts how often it was asked. */
const fakeMac = () => {
  const woken: string[] = [];
  return {
    woken,
    local: {
      start: (): Promise<LocalTranscriberStart> =>
        Promise.resolve({ ok: true, detail: 'restarted' }),
      wake: (): Promise<LocalTranscriberStart> => {
        woken.push('wake');
        return Promise.resolve({ ok: true, detail: 'started' });
      },
    },
  };
};

const world = (
  over: { waiting?: number; online?: boolean; local?: boolean } = {},
) => {
  const mac = fakeMac();
  let clock = new Date('2026-11-09T12:00:00.000Z');
  const state = {
    waiting: over.waiting ?? 1,
    online: over.online ?? false,
  };
  const waker = new TranscriberWaker({
    local: over.local === false ? null : mac.local,
    waiting: () => state.waiting,
    isOnline: () => state.online,
    now: () => clock,
  });
  const later = (ms: number) => {
    clock = new Date(clock.getTime() + ms);
  };
  return { mac, waker, state, later };
};

describe('TranscriberWaker (KBC-114 AC-15: the owner never starts the transcriber by hand)', () => {
  it('starts the service when a job waits and no transcriber is on', async () => {
    const { mac, waker } = world();
    expect(await waker.check()).toBe('woken');
    expect(mac.woken).toEqual(['wake']);
  });

  it('leaves it alone with nothing waiting, or with a transcriber on', async () => {
    const idle = world({ waiting: 0 });
    expect(await idle.waker.check()).toBe('nothing-waiting');
    const on = world({ online: true });
    expect(await on.waker.check()).toBe('online');
    expect([...idle.mac.woken, ...on.mac.woken]).toEqual([]);
  });

  it('asks launchd at most once a minute, however many jobs arrive', async () => {
    const { mac, waker, later } = world();
    await Promise.all([waker.check(), waker.check(), waker.check()]);
    later(30_000);
    expect(await waker.check()).toBe('cooling-down');
    later(31_000);
    expect(await waker.check()).toBe('woken');
    expect(mac.woken).toHaveLength(2);
  });

  it('in production (no local launchctl) never tries', async () => {
    const { waker } = world({ local: false });
    expect(await waker.check()).toBe('not-local');
  });

  it('a launchctl that throws is logged, never thrown', async () => {
    const errors: unknown[] = [];
    const waker = new TranscriberWaker({
      local: {
        start: () => Promise.reject(new Error('x')),
        wake: () => Promise.reject(new Error('launchctl gone')),
      },
      waiting: () => 1,
      isOnline: () => false,
      onError: (err) => errors.push(err),
    });
    expect(await waker.check()).toBe('failed');
    expect(errors).toHaveLength(1);
  });
});
