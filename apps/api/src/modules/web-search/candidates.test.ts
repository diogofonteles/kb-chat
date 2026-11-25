import { describe, expect, it } from 'vitest';
import { candidatesOf } from './candidates.js';

const hit = (url: string, title = 'Título', description = 'Trecho') => ({
  url,
  title,
  description,
});
const page = { kind: 'page', limit: 10 } as const;
const video = { kind: 'video', limit: 10 } as const;

describe('candidatesOf (KBC-185)', () => {
  it('gives each page once, with its site', () => {
    expect(
      candidatesOf(
        [
          hit('https://www.a.org/x'),
          hit('https://www.a.org/x'),
          hit('http://b.org/y'),
        ],
        page,
      ),
    ).toEqual([
      {
        kind: 'page',
        url: 'https://www.a.org/x',
        title: 'Título',
        snippet: 'Trecho',
        site: 'a.org',
      },
      {
        kind: 'page',
        url: 'http://b.org/y',
        title: 'Título',
        snippet: 'Trecho',
        site: 'b.org',
      },
    ]);
  });

  it('drops what the app does not take as a link', () => {
    expect(
      candidatesOf(
        [
          hit('ftp://a.org/x'),
          hit('https://user:senha@a.org/x'),
          hit('https://localhost/x'),
          hit('a.org/x'),
          hit(`https://a.org/${'x'.repeat(2_000)}`),
        ],
        page,
      ),
    ).toEqual([]);
  });

  it('keeps only real video pages as videos, and none of them as pages', () => {
    const hits = [
      hit('https://www.youtube.com/@canal'),
      hit('https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=3s'),
      hit('https://youtu.be/dQw4w9WgXcQ'),
      hit('https://vimeo.com/76979871'),
      hit('https://a.org/x'),
    ];
    expect(candidatesOf(hits, video).map((one) => one.url)).toEqual([
      'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
      'https://vimeo.com/76979871',
    ]);
    expect(candidatesOf(hits, page).map((one) => one.url)).toEqual([
      'https://a.org/x',
    ]);
  });

  it('puts title and snippet on one line, cut to what the contract takes', () => {
    const [one] = candidatesOf(
      [hit('https://a.org/x', ' A\n  B ', 'c '.repeat(600))],
      page,
    );
    expect(one?.title).toBe('A B');
    expect(one?.snippet).toHaveLength(600);
    expect(one?.snippet.endsWith('…')).toBe(true);
  });

  it('names a result without a title by its site, and stops at the limit', () => {
    const hits = Array.from({ length: 8 }, (_, at) =>
      hit(`https://www.a.org/${at}`, '  '),
    );
    const found = candidatesOf(hits, { kind: 'page', limit: 5 });
    expect(found).toHaveLength(5);
    expect(found[0]?.title).toBe('a.org');
  });
});
