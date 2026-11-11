import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  FADE_MS,
  SLEEP_MINUTES,
  TIMER_OFF,
  advanceTimer,
  extendTimer,
  fadeFactor,
  startTimer,
} from './sleep-timer.js';

describe('sleep timer (KBC-046)', () => {
  it('starts off', () => {
    expect(TIMER_OFF).toEqual({ kind: 'off' });
  });

  it('offers 5 to 60 minutes and the end of the media', () => {
    expect(SLEEP_MINUTES).toEqual([5, 10, 15, 30, 45, 60]);
    expect(startTimer('end-of-media')).toEqual({ kind: 'end-of-media' });
    expect(startTimer(15)).toEqual({ kind: 'minutes', remainingMs: 900_000 });
  });

  it('counts real time only while playing (BR-1)', () => {
    const timer = startTimer(5);
    const played = advanceTimer(timer, 60_000, true);
    expect(played).toEqual({ kind: 'minutes', remainingMs: 240_000 });
    expect(advanceTimer(played, 120_000, false)).toEqual(played);
  });

  it('never goes below zero and says when it is done', () => {
    const almost = { kind: 'minutes', remainingMs: 1_000 } as const;
    expect(advanceTimer(almost, 5_000, true)).toEqual({
      kind: 'minutes',
      remainingMs: 0,
    });
  });

  it('leaves an "end of media" timer and an off timer as they are', () => {
    expect(advanceTimer({ kind: 'end-of-media' }, 5_000, true)).toEqual({
      kind: 'end-of-media',
    });
    expect(advanceTimer(TIMER_OFF, 5_000, true)).toBe(TIMER_OFF);
  });

  it('adds 5 minutes to what is left (FR-3)', () => {
    expect(extendTimer({ kind: 'minutes', remainingMs: 30_000 })).toEqual({
      kind: 'minutes',
      remainingMs: 330_000,
    });
    expect(extendTimer({ kind: 'end-of-media' })).toEqual({
      kind: 'end-of-media',
    });
    expect(extendTimer(TIMER_OFF)).toBe(TIMER_OFF);
  });

  it('turns the sound down over the last 10 s (FR-2)', () => {
    expect(FADE_MS).toBe(10_000);
    expect(fadeFactor({ kind: 'minutes', remainingMs: 60_000 })).toBe(1);
    expect(fadeFactor({ kind: 'minutes', remainingMs: 10_000 })).toBe(1);
    expect(fadeFactor({ kind: 'minutes', remainingMs: 5_000 })).toBe(0.5);
    expect(fadeFactor({ kind: 'minutes', remainingMs: 0 })).toBe(0);
    expect(fadeFactor({ kind: 'end-of-media' })).toBe(1);
    expect(fadeFactor(TIMER_OFF)).toBe(1);
  });

  it('only ever counts down, by at most the time that passed', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 3_600_000 }),
        fc.integer({ min: 0, max: 600_000 }),
        fc.boolean(),
        (remainingMs, elapsed, playing) => {
          const next = advanceTimer(
            { kind: 'minutes', remainingMs },
            elapsed,
            playing,
          );
          if (next.kind !== 'minutes') throw new Error('kind changed');
          expect(next.remainingMs).toBeLessThanOrEqual(remainingMs);
          expect(remainingMs - next.remainingMs).toBeLessThanOrEqual(elapsed);
        },
      ),
    );
  });
});
