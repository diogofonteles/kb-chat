import { describe, expect, it } from 'vitest';
import { SweepPacer, type SweepClock } from './sweep-pacing.js';

/** Time moves only by sleeping. */
class FakeClock implements SweepClock {
  time = 0;
  now(): number {
    return this.time;
  }
  async sleep(ms: number): Promise<void> {
    this.time += ms;
  }
}

describe('SweepPacer', () => {
  it('spaces request starts by the gap', async () => {
    const pacer = new SweepPacer(3_200);
    const clock = new FakeClock();
    const signal = new AbortController().signal;
    await pacer.wait(clock, signal);
    await pacer.wait(clock, signal);
    expect(clock.time).toBe(3_200);
  });

  it('gives a stopped sweep’s start back to the others (code review round 2)', async () => {
    const pacer = new SweepPacer(3_200);
    const clock = new FakeClock();
    const stopped = new AbortController();
    await pacer.wait(clock, new AbortController().signal);
    stopped.abort();
    await pacer.wait(clock, stopped.signal);
    const before = clock.time;
    await pacer.wait(clock, new AbortController().signal);
    // The next sweep starts in the slot the stopped one did not use.
    expect(clock.time - before).toBe(0);
  });
});
