import { describe, expect, it } from 'vitest';
import {
  candidatesOf,
  interleave,
  pageKey,
  type Candidate,
} from './candidates.js';

const hit = (url: string, title = 'Título', description = 'Trecho') => ({
  url,
  title,
  description,
});
const TEXT = { kind: 'text', author: null } as const;
const AUDIO = { kind: 'audio', author: null } as const;
const VIDEO = { kind: 'video', author: 'Hermes' } as const;

const a = (url: string, author: string | null = null): Candidate => ({
  kind: 'text',
  url,
  title: url,
  snippet: '',
  site: 'a.org',
  author,
});
const urls = (candidates: readonly Candidate[]) =>
  candidates.map((one) => one.url);

describe('candidatesOf (KBC-185)', () => {
  it('gives each hit with its site and whose search found it', () => {
    expect(
      candidatesOf([hit('https://www.a.org/x')], {
        kind: 'text',
        author: 'Hermes',
      }),
    ).toEqual([
      {
        kind: 'text',
        url: 'https://www.a.org/x',
        title: 'Título',
        snippet: 'Trecho',
        site: 'a.org',
        author: 'Hermes',
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
        TEXT,
      ),
    ).toEqual([]);
  });

  it('keeps only item pages as audio and video, and none of their sites as text', () => {
    const hits = [
      hit('https://www.youtube.com/@canal'),
      hit('https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=3s'),
      hit('https://vimeo.com/76979871'),
      hit('https://soundcloud.com/alguem/aula'),
      hit('https://archive.org/details/palestra'),
      hit('https://podcasts.apple.com/br/podcast/x/id1?i=2'),
      hit('https://podcasts.apple.com/br/podcast/x/id1'),
      hit('https://a.org/x'),
    ];
    expect(urls(candidatesOf(hits, VIDEO))).toEqual([
      'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
      'https://vimeo.com/76979871',
    ]);
    expect(urls(candidatesOf(hits, AUDIO))).toEqual([
      'https://soundcloud.com/alguem/aula',
      'https://archive.org/details/palestra',
      'https://podcasts.apple.com/br/podcast/x/id1?i=2',
    ]);
    expect(urls(candidatesOf(hits, TEXT))).toEqual(['https://a.org/x']);
  });

  it('puts title and snippet on one line, cut to what the contract takes', () => {
    const [one] = candidatesOf(
      [hit('https://a.org/x', ' A\n  B ', 'c '.repeat(600))],
      TEXT,
    );
    expect(one?.title).toBe('A B');
    expect(one?.snippet).toHaveLength(600);
    expect(one?.snippet.endsWith('…')).toBe(true);
  });

  it('names a result without a title by its site', () => {
    const [one] = candidatesOf([hit('https://www.a.org/x', '  ')], TEXT);
    expect(one?.title).toBe('a.org');
  });
});

describe('pageKey', () => {
  it('is the same for the same page', () => {
    const key = pageKey('https://a.org/x?b=2&a=1');
    for (const url of [
      'http://www.a.org/x/?a=1&b=2',
      'https://A.org/x?b=2&a=1&utm_source=y&fbclid=z#trecho',
    ])
      expect(pageKey(url), url).toBe(key);
  });

  it('is another for another page', () => {
    const key = pageKey('https://a.org/x?id=1');
    for (const url of [
      'https://a.org/x?id=2',
      'https://a.org/X?id=1',
      'https://b.org/x?id=1',
      'https://a.org:8443/x?id=1',
      'https://a.org/x',
    ])
      expect(pageKey(url), url).not.toBe(key);
  });
});

describe('interleave', () => {
  it('takes one of each search in turn, up to the sources wanted', () => {
    const groups = [
      [a('https://a.org/1'), a('https://a.org/2'), a('https://a.org/3')],
      [a('https://b.org/1')],
      [a('https://c.org/1'), a('https://c.org/2')],
    ];
    expect(urls(interleave(groups, 5))).toEqual([
      'https://a.org/1',
      'https://b.org/1',
      'https://c.org/1',
      'https://a.org/2',
      'https://c.org/2',
    ]);
    expect(interleave(groups, 2)).toHaveLength(2);
    expect(interleave(groups, 30)).toHaveLength(6);
    expect(interleave([], 10)).toEqual([]);
  });

  it('takes a page once, for the search that reaches it first, and the turn still gives one', () => {
    const groups = [
      [a('https://a.org/1', 'Ana'), a('https://a.org/2', 'Ana')],
      [a('http://www.a.org/1/', 'Bia'), a('https://b.org/1', 'Bia')],
    ];
    expect(interleave(groups, 10).map((one) => [one.url, one.author])).toEqual([
      ['https://a.org/1', 'Ana'],
      ['https://b.org/1', 'Bia'],
      ['https://a.org/2', 'Ana'],
    ]);
  });
});
