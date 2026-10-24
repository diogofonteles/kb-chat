import { describe, expect, it } from 'vitest';
import { apiErrorSchema } from './errors.js';
import { documentSchema } from './documents.js';
import { healthSchema } from './health.js';

describe('contract schemas', () => {
  it('accept a document with nullable facets and empty see-also groups', () => {
    const empty = { items: [], total: 0 };
    const doc = {
      id: 'a.md',
      title: 'A',
      summary: null,
      criterion: null,
      origin: null,
      obsidianUrl: 'obsidian://open?vault=v&file=t%2Fa',
      seeAlso: {
        exampleOf: empty,
        extends: empty,
        related: empty,
        examples: empty,
        extendedBy: empty,
        relatedFrom: empty,
      },
      body: '',
      genre: null,
      depth: null,
      relevance: null,
      concepts: [],
    };
    expect(documentSchema.parse(doc)).toEqual(doc);
    expect(documentSchema.safeParse({ ...doc, origin: 'video' }).success).toBe(
      false,
    );
  });

  it('accept only known error codes', () => {
    expect(
      apiErrorSchema.safeParse({
        error: { code: 'TOPIC_NOT_FOUND', message: 'x' },
      }).success,
    ).toBe(true);
    expect(
      apiErrorSchema.safeParse({ error: { code: 'NOPE', message: 'x' } })
        .success,
    ).toBe(false);
  });

  it('accept a degraded health report', () => {
    const health = {
      status: 'degraded',
      search: 'degraded',
      catalog: { documents: 3 },
    };
    expect(healthSchema.parse(health)).toEqual(health);
  });
});
