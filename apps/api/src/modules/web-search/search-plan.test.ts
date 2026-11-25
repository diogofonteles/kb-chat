import { describe, expect, it } from 'vitest';
import { groupLimit, groupsOf, queryOf } from './search-plan.js';

const REQUEST = {
  query: 'hermetismo',
  sources: 10,
  kinds: ['text' as const, 'audio' as const, 'video' as const],
  authors: [],
};

describe('groupsOf (KBC-185)', () => {
  it('is one search per kind when there is no author', () => {
    expect(groupsOf(REQUEST)).toEqual([
      { kind: 'text', author: null, query: 'hermetismo' },
      {
        kind: 'audio',
        author: null,
        query: 'hermetismo',
        domains: ['soundcloud.com', 'archive.org', 'podcasts.apple.com'],
      },
      {
        kind: 'video',
        author: null,
        query: 'hermetismo',
        domains: ['youtube.com', 'vimeo.com'],
      },
    ]);
  });

  it('is one per kind and author, 15 at most', () => {
    const authors = ['Ana', 'Bia', 'Caio', 'Davi', 'Eva'];
    const groups = groupsOf({ ...REQUEST, authors });
    expect(groups).toHaveLength(15);
    expect(groups.slice(0, 4).map((one) => [one.kind, one.author])).toEqual([
      ['text', 'Ana'],
      ['audio', 'Ana'],
      ['video', 'Ana'],
      ['text', 'Bia'],
    ]);
    expect(groups[3]?.query).toBe('hermetismo "Bia"');
  });
});

describe('queryOf', () => {
  it('leaves the subject as typed when there is no author', () => {
    expect(queryOf('"a palavra" perdida', null)).toBe('"a palavra" perdida');
  });

  it('puts the name in quotes, without its own', () => {
    expect(queryOf('alquimia', 'Manly "P." Hall')).toBe(
      'alquimia "Manly P. Hall"',
    );
    expect(queryOf('alquimia', '“Hermes”')).toBe('alquimia "Hermes"');
  });

  it('never lets a quote of the subject swallow the name', () => {
    expect(queryOf('a "palavra', 'Hermes')).toBe('a palavra "Hermes"');
  });

  it('fits what Firecrawl takes, cutting the subject and never the name', () => {
    const query = queryOf('a'.repeat(500), 'Hermes');
    expect(query).toHaveLength(500);
    expect(query.endsWith('a "Hermes"')).toBe(true);
  });
});

describe('groupLimit', () => {
  it.each([
    [10, 1, 13],
    [10, 3, 7],
    [30, 1, 20],
    [30, 2, 18],
    [1, 15, 4],
    [30, 15, 5],
  ])(
    'asks, for %i sources in %i searches, %i each',
    (sources, groups, each) => {
      expect(groupLimit(sources, groups)).toBe(each);
    },
  );
});
