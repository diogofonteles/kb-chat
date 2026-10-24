import { describe, expect, it } from 'vitest';
import { WINDOW_CHARS, foldKeepingLength, windowOf } from './body-window.js';

const filler = (chars: number): string =>
  'texto de enchimento sem o termo. '
    .repeat(Math.ceil(chars / 33))
    .slice(0, chars);

describe('foldKeepingLength', () => {
  it('drops accents and case but keeps one character per character', () => {
    const text = 'Princípios OCULTOS ação';
    expect(foldKeepingLength(text)).toBe('principios ocultos acao');
    expect(foldKeepingLength(text)).toHaveLength(text.length);
  });
});

describe('windowOf', () => {
  it('starts at the beginning when nothing is asked', () => {
    const body = filler(20_000);
    const window = windowOf(body, {});
    expect(window).toMatchObject({
      start: 0,
      end: WINDOW_CHARS,
      total: 20_000,
      matches: null,
    });
    expect(window.text).toHaveLength(WINDOW_CHARS);
  });

  it('centers on the occurrences of `around`, ignoring accents and case', () => {
    const body = `${filler(30_000)}\nOs Cinco Princípios Ocultos são estes.\n${filler(30_000)}`;
    const window = windowOf(body, { around: 'principios ocultos' });
    expect(window.start).toBeGreaterThan(25_000);
    expect(window.text).toContain('Os Cinco Princípios Ocultos');
    expect(window.text.startsWith('Os Cinco')).toBe(false);
    expect(window.matches).toBe(1);
  });

  it('falls back to the longer words when the phrase does not occur', () => {
    const body = `${filler(20_000)} o ritmo do mundo ${filler(20_000)}`;
    const window = windowOf(body, { around: 'lei do ritmo' });
    expect(window.text).toContain('o ritmo do mundo');
    expect(window.matches).toBe(1);
  });

  it('prefers the densest region and continues from an offset', () => {
    const body = `alfa ${filler(40_000)} alfa alfa alfa ${filler(40_000)}`;
    const dense = windowOf(body, { around: 'alfa' });
    expect(dense.start).toBeGreaterThan(30_000);
    expect(dense.matches).toBe(3);
    const later = windowOf(body, { offset: 70_000 });
    expect(later.start).toBe(70_000);
    expect(later.end).toBe(body.length);
  });

  it('reports no match and reads from the offset when `around` never occurs', () => {
    const window = windowOf('curto', { around: 'inexistente', offset: 99 });
    expect(window).toMatchObject({
      start: 5,
      end: 5,
      total: 5,
      matches: 0,
      text: '',
    });
  });
});
