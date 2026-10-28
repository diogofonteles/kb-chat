import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  clockParts,
  formatClock,
  formatRemaining,
  spokenTime,
  type SpokenUnits,
} from './time.js';

const PT: SpokenUnits = {
  hour: ['hora', 'horas'],
  minute: ['minuto', 'minutos'],
  second: ['segundo', 'segundos'],
  and: 'e',
};

describe('formatClock', () => {
  it.each([
    [0, '0:00'],
    [999, '0:00'],
    [5_000, '0:05'],
    [65_000, '1:05'],
    [754_000, '12:34'],
    [3_599_999, '59:59'],
    [3_600_000, '1:00:00'],
    [3_735_000, '1:02:15'],
    [36_000_000, '10:00:00'],
  ])('shows %i ms as %s', (ms, text) => {
    expect(formatClock(ms)).toBe(text);
  });

  it('treats negative and non-finite times as zero', () => {
    expect(formatClock(-5_000)).toBe('0:00');
    expect(formatClock(Number.NaN)).toBe('0:00');
    expect(formatClock(Number.POSITIVE_INFINITY)).toBe('0:00');
  });

  it('always has two-digit seconds and, from an hour on, two-digit minutes', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 100 * 3_600_000 }), (ms) => {
        const text = formatClock(ms);
        const pattern = ms >= 3_600_000 ? /^\d+:\d\d:\d\d$/ : /^\d{1,2}:\d\d$/;
        expect(text).toMatch(pattern);
      }),
    );
  });

  it('round-trips through its parts', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 100 * 3_600_000 }), (ms) => {
        const { hours, minutes, seconds } = clockParts(ms);
        expect(hours * 3600 + minutes * 60 + seconds).toBe(
          Math.floor(ms / 1000),
        );
        expect(minutes).toBeLessThan(60);
        expect(seconds).toBeLessThan(60);
      }),
    );
  });
});

describe('formatRemaining', () => {
  it('shows the time left with a minus sign, never below zero', () => {
    expect(formatRemaining(1_390_000, 3_735_000)).toBe('-39:05');
    expect(formatRemaining(5_000, 3_000)).toBe('-0:00');
  });
});

describe('spokenTime', () => {
  it.each([
    [0, '0 segundos'],
    [1_000, '1 segundo'],
    [60_000, '1 minuto'],
    [61_000, '1 minuto e 1 segundo'],
    [1_390_000, '23 minutos e 10 segundos'],
    [3_600_000, '1 hora'],
    [3_660_000, '1 hora e 1 minuto'],
    [3_601_000, '1 hora e 1 segundo'],
    [3_735_000, '1 hora, 2 minutos e 15 segundos'],
    [7_322_000, '2 horas, 2 minutos e 2 segundos'],
  ])('speaks %i ms as "%s"', (ms, text) => {
    expect(spokenTime(ms, PT)).toBe(text);
  });
});
