import { describe, expect, it } from 'vitest';
import { groupsOf, queryOf } from './search-plan.js';

const REQUEST = {
  query: 'cocriação',
  kinds: ['text' as const, 'audio' as const, 'video' as const],
  authors: [],
};

describe('groupsOf (KBC-185)', () => {
  it('is one search per kind, the subject alone first, each site on its own', () => {
    expect(groupsOf(REQUEST, 0)).toEqual([
      { kind: 'text', author: null, query: 'cocriação' },
      {
        kind: 'audio',
        author: null,
        query: 'cocriação',
        domains: ['podcasts.apple.com'],
      },
      {
        kind: 'video',
        author: null,
        query: 'cocriação',
        domains: ['youtube.com'],
      },
    ]);
  });

  it('asks in other words each round, and never twice the same', () => {
    const seen = new Set<string>();
    let rounds = 0;
    for (
      let groups = groupsOf(REQUEST, 0);
      groups.length > 0;
      groups = groupsOf(REQUEST, ++rounds)
    )
      for (const { kind, query, domains } of groups) {
        const one = JSON.stringify([kind, query, domains]);
        expect(seen.has(one), one).toBe(false);
        seen.add(one);
      }
    expect(rounds).toBeGreaterThanOrEqual(10);
  });

  it('is one per kind and author, as many as they are', () => {
    const authors = Array.from({ length: 12 }, (_, at) => `Autor ${at}`);
    const groups = groupsOf({ ...REQUEST, authors }, 0);
    expect(groups).toHaveLength(36);
    expect(groups.slice(0, 4).map((one) => [one.kind, one.query])).toEqual([
      ['text', 'cocriação Autor 0'],
      ['audio', 'cocriação Autor 0'],
      ['video', 'cocriação Autor 0'],
      ['text', 'cocriação Autor 1'],
    ]);
  });
});

describe('queryOf', () => {
  it('leaves the subject as typed when there is no author', () => {
    expect(queryOf('"a palavra" perdida', null)).toBe('"a palavra" perdida');
  });

  it('never puts the name in quotes: spelled another way it would find nothing', () => {
    expect(queryOf('cocriação', 'Joseph "Murph"')).toBe(
      'cocriação Joseph Murph',
    );
    expect(queryOf('cocriação', 'Helio Couto', 'aula')).toBe(
      'cocriação Helio Couto aula',
    );
  });

  it('fits what the engine takes, cutting the subject and never the name', () => {
    const query = queryOf('a'.repeat(500), 'Hermes', 'aula');
    expect(query).toHaveLength(500);
    expect(query.endsWith('a Hermes aula')).toBe(true);
  });
});
