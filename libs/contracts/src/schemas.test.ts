import { describe, expect, it } from 'vitest';
import { apiErrorSchema } from './errors.js';
import { documentSchema } from './documents.js';
import { healthSchema } from './health.js';

describe('contract schemas', () => {
  it('accept a document with nullable facets', () => {
    const doc = {
      id: 'a.md',
      title: 'A',
      summary: null,
      body: '',
      genre: null,
      depth: null,
      relevance: null,
      concepts: [],
    };
    expect(documentSchema.parse(doc)).toEqual(doc);
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
