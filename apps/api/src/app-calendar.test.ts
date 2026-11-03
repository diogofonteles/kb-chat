import { describe, expect, it } from 'vitest';
import { startOfAppDay, startOfAppMonth } from './app-calendar.js';

describe('the app calendar (KBC-061)', () => {
  it('starts the day at midnight in Recife (03:00 UTC), whatever the process zone', () => {
    // Mariano's case: a research at 22:06 in Recife (01:06 UTC the next day)…
    expect(startOfAppDay(new Date('2026-11-01T01:06:00Z')).toISOString()).toBe(
      '2026-10-31T03:00:00.000Z',
    );
    // …belongs to 31/10; at 09:34 in Recife on 01/11 a new day has begun.
    expect(startOfAppDay(new Date('2026-11-01T12:34:00Z')).toISOString()).toBe(
      '2026-11-01T03:00:00.000Z',
    );
  });

  it('puts the very first and last second of a day in it', () => {
    expect(startOfAppDay(new Date('2026-11-03T03:00:00Z')).toISOString()).toBe(
      '2026-11-03T03:00:00.000Z',
    );
    expect(startOfAppDay(new Date('2026-11-04T02:59:59Z')).toISOString()).toBe(
      '2026-11-03T03:00:00.000Z',
    );
  });

  it('starts the month on the 1st at midnight in Recife', () => {
    expect(
      startOfAppMonth(new Date('2026-12-01T02:00:00Z')).toISOString(),
    ).toBe('2026-11-01T03:00:00.000Z');
    expect(
      startOfAppMonth(new Date('2026-12-01T03:00:00Z')).toISOString(),
    ).toBe('2026-12-01T03:00:00.000Z');
  });

  it('follows a zone with daylight saving on the night it changes', () => {
    // São Paulo had DST until 2019: on 2018-11-04 midnight did not exist (00:00 → 01:00).
    expect(
      startOfAppDay(
        new Date('2018-11-04T12:00:00Z'),
        'America/Sao_Paulo',
      ).toISOString(),
    ).toBe('2018-11-04T03:00:00.000Z');
    expect(
      startOfAppDay(
        new Date('2026-07-10T12:00:00Z'),
        'Europe/Lisbon',
      ).toISOString(),
    ).toBe('2026-07-09T23:00:00.000Z');
  });
});
