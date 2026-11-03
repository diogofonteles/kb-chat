import { describe, expect, it } from 'vitest';
import { minuteLink, quoteWithLink, startFromParam } from './minute-link.js';

describe('startFromParam (KBC-038 FR-5)', () => {
  it('reads whole seconds as ms', () => {
    expect(startFromParam('754')).toBe(754_000);
    expect(startFromParam('0')).toBe(0);
    expect(startFromParam('360000')).toBe(360_000_000);
  });

  it('ignores what is not a whole number of seconds in range', () => {
    for (const value of [
      null,
      undefined,
      '',
      '-1',
      '1.5',
      '12:34',
      'abc',
      '360001',
      '1234567',
    ])
      expect(startFromParam(value)).toBeNull();
  });
});

describe('minuteLink', () => {
  it('links to the second, floored, replacing an old t and keeping the rest', () => {
    expect(minuteLink('https://app.test/midia/abc', 754_999)).toBe(
      'https://app.test/midia/abc?t=754',
    );
    expect(minuteLink('https://app.test/midia/abc?t=1&x=2', 61_000)).toBe(
      'https://app.test/midia/abc?t=61&x=2',
    );
    expect(minuteLink('https://app.test/midia/abc', -5)).toBe(
      'https://app.test/midia/abc?t=0',
    );
  });
});

describe('quoteWithLink (FR-9, AC-10)', () => {
  it('puts the passage in quotes, then the title and the link', () => {
    expect(
      quoteWithLink({
        text: '  o \n vegetal ',
        title: 'Palestra de 1998',
        link: 'https://app.test/midia/abc?t=754',
      }),
    ).toBe('“o vegetal”\nPalestra de 1998\nhttps://app.test/midia/abc?t=754');
  });
});
