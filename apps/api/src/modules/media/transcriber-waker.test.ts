import type { LocalTranscriberStart, MediaJobKind } from '@kb-chat/contracts';
import { describe, expect, it } from 'vitest';
import { TranscriberWaker } from './transcriber-waker.js';

interface WorldOptions {
  readonly backlog?: { kind: MediaJobKind; ready: number }[];
  readonly takers?: MediaJobKind[];
  readonly online?: boolean;
  readonly local?: boolean;
}

/** A Mac whose launchctl only counts how often it was asked, with a clock of its own. */
const world = (over: WorldOptions = {}) => {
  const woken: string[] = [];
  let clock = new Date('2026-11-09T12:00:00.000Z');
  const state = {
    backlog: over.backlog ?? [{ kind: 'transcribe' as MediaJobKind, ready: 1 }],
    takers: new Set<MediaJobKind>(over.takers ?? ['transcribe']),
    online: over.online ?? false,
    stoppedAt: null as Date | null,
  };
  const local = {
    start: (): Promise<LocalTranscriberStart> =>
      Promise.resolve({ ok: true, detail: 'restarted' }),
    wake: (): Promise<LocalTranscriberStart> => {
      woken.push('wake');
      return Promise.resolve({ ok: true, detail: 'started' });
    },
  };
  const waker = new TranscriberWaker({
    local: over.local === false ? null : local,
    backlog: () => state.backlog,
    takers: () => state.takers,
    isOnline: () => state.online,
    stoppedSince: (at) =>
      state.stoppedAt !== null && state.stoppedAt.getTime() >= at.getTime(),
    now: () => clock,
  });
  const later = (ms: number) => {
    clock = new Date(clock.getTime() + ms);
  };
  /** The transcriber ran, found nothing it takes, and exited saying so. */
  const ranAndStopped = () => {
    later(40_000);
    state.stoppedAt = clock;
    later(30_000);
  };
  return { woken, waker, state, later, ranAndStopped };
};

describe('TranscriberWaker (KBC-114 AC-15: the owner never starts the transcriber by hand)', () => {
  it('starts the service when a job it can take waits and no transcriber is on', async () => {
    const { woken, waker } = world();
    expect(await waker.check()).toBe('woken');
    expect(woken).toEqual(['wake']);
  });

  it('leaves it alone with nothing waiting, or with a transcriber on', async () => {
    const idle = world({ backlog: [] });
    expect(await idle.waker.check()).toBe('nothing-waiting');
    const on = world({ online: true });
    expect(await on.waker.check()).toBe('online');
    expect([...idle.woken, ...on.woken]).toEqual([]);
  });

  it('asks launchd at most once a minute, however many jobs arrive', async () => {
    const { woken, waker, later, state } = world();
    await Promise.all([waker.check(), waker.check(), waker.check()]);
    later(30_000);
    expect(await waker.check()).toBe('cooling-down');
    later(31_000);
    state.backlog = [{ kind: 'transcribe', ready: 2 }];
    expect(await waker.check()).toBe('woken');
    expect(woken).toHaveLength(2);
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
      backlog: () => [{ kind: 'transcribe', ready: 1 }],
      takers: () => new Set(['transcribe']),
      isOnline: () => false,
      stoppedSince: () => false,
      onError: (err) => errors.push(err),
    });
    expect(await waker.check()).toBe('failed');
    expect(errors).toHaveLength(1);
  });
});

describe('TranscriberWaker never relaunches for work nobody can take (review BR-15, QA F-1)', () => {
  it('a job no paired transcriber takes starts nothing, and says what is blocked', async () => {
    // QA's probe: only "Publica no acervo" is marked, and a transcription waits.
    const { woken, waker } = world({
      backlog: [{ kind: 'transcribe', ready: 1 }],
      takers: ['kb-publish'],
    });
    expect(await waker.check()).toBe('nothing-waiting');
    expect(woken).toEqual([]);
    expect(waker.attention()).toEqual({
      blocked: [{ kind: 'transcribe', ready: 1 }],
      stuck: null,
    });
  });

  it('a launch that ended with no work, the queue unchanged, is not repeated', async () => {
    const { woken, waker, ranAndStopped } = world();
    expect(await waker.check()).toBe('woken');
    ranAndStopped();
    expect(await waker.check()).toBe('stuck');
    expect(await waker.check()).toBe('stuck');
    expect(woken).toHaveLength(1);
    expect(waker.attention().stuck).toEqual({ ready: 1 });
  });

  it('new work after a fruitless launch starts it again', async () => {
    const { woken, waker, ranAndStopped, state } = world();
    await waker.check();
    ranAndStopped();
    expect(await waker.check()).toBe('stuck');
    state.backlog = [{ kind: 'transcribe', ready: 2 }];
    expect(await waker.check()).toBe('woken');
    expect(woken).toHaveLength(2);
    expect(waker.attention().stuck).toBeNull();
  });

  it('a transcriber that never says anything is not relaunched past 3 tries', async () => {
    const { woken, waker, later } = world();
    for (let tries = 0; tries < 6; tries += 1) {
      await waker.check();
      later(61_000);
    }
    expect(woken).toHaveLength(3);
    expect(await waker.check()).toBe('stuck');
  });
});
