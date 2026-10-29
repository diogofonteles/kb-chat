import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { entityTagOf, parseRange, rangeStillValid } from './range.js';

const SIZE = 1_000;

describe('parseRange', () => {
  it.each([
    ['bytes=0-0', 0, 0],
    ['bytes=0-499', 0, 499],
    ['bytes=500-', 500, 999],
    ['bytes=500-5000', 500, 999],
    ['bytes=-100', 900, 999],
    ['bytes=-5000', 0, 999],
    [' bytes=10-20 ', 10, 20],
  ])('answers %s with bytes %i–%i', (header, start, end) => {
    expect(parseRange(header, SIZE)).toEqual({ kind: 'partial', start, end });
  });

  it.each([
    undefined,
    '',
    'bytes=',
    'bytes=-',
    'items=0-1',
    'bytes=a-b',
    'bytes=0-1,5-6',
    'bytes=20-10',
  ])('sends the whole file for %s', (header) => {
    expect(parseRange(header, SIZE)).toEqual({ kind: 'full' });
  });

  it.each(['bytes=1000-', 'bytes=1000-2000', 'bytes=-0'])(
    'is unsatisfiable for %s (416)',
    (header) => {
      expect(parseRange(header, SIZE)).toEqual({ kind: 'unsatisfiable' });
    },
  );

  it('cannot serve any range of an empty file', () => {
    expect(parseRange('bytes=0-', 0)).toEqual({ kind: 'unsatisfiable' });
    expect(parseRange('bytes=-1', 0)).toEqual({ kind: 'unsatisfiable' });
  });

  it('always answers a range inside the file (property)', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 1_000_000 }),
        fc.option(fc.nat({ max: 2_000_000 }), { nil: undefined }),
        fc.option(fc.nat({ max: 2_000_000 }), { nil: undefined }),
        (size, first, last) => {
          const header = `bytes=${first ?? ''}-${last ?? ''}`;
          const answer = parseRange(header, size);
          if (answer.kind !== 'partial') return;
          expect(answer.start).toBeGreaterThanOrEqual(0);
          expect(answer.start).toBeLessThanOrEqual(answer.end);
          expect(answer.end).toBeLessThan(size);
        },
      ),
    );
  });

  it('serves exactly the asked bytes when they fit (property)', () => {
    fc.assert(
      fc.property(
        fc
          .integer({ min: 1, max: 1_000_000 })
          .chain((size) =>
            fc.tuple(
              fc.constant(size),
              fc.nat({ max: size - 1 }),
              fc.nat({ max: size - 1 }),
            ),
          ),
        ([size, a, b]) => {
          const [start, end] = a <= b ? [a, b] : [b, a];
          expect(parseRange(`bytes=${start}-${end}`, size)).toEqual({
            kind: 'partial',
            start,
            end,
          });
        },
      ),
    );
  });
});

describe('rangeStillValid', () => {
  const etag = '"id-10-20"';
  it('keeps the range without If-Range or with the current tag', () => {
    expect(rangeStillValid(undefined, etag)).toBe(true);
    expect(rangeStillValid(' "id-10-20" ', etag)).toBe(true);
  });

  it('drops the range for an old tag, a weak tag or a date', () => {
    expect(rangeStillValid('"id-10-19"', etag)).toBe(false);
    expect(rangeStillValid('W/"id-10-20"', etag)).toBe(false);
    expect(rangeStillValid('Tue, 28 Oct 2026 12:00:00 GMT', etag)).toBe(false);
  });
});

describe('entityTagOf', () => {
  it('changes with the size and the modification time', () => {
    const tag = entityTagOf('m1', { size: 10, modifiedMs: 20.7 });
    expect(tag).toBe('"m1-10-20"');
    expect(entityTagOf('m1', { size: 11, modifiedMs: 20 })).not.toBe(tag);
    expect(entityTagOf('m1', { size: 10, modifiedMs: 21 })).not.toBe(tag);
  });
});
