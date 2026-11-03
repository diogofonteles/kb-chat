import { describe, expect, it } from 'vitest';
import { searchRequestSchema } from './search.js';
import { topicSlugSchema } from './topics.js';

describe('searchRequestSchema', () => {
  it('defaults the mode to all and the limit to 10', () => {
    const parsed = searchRequestSchema.parse({ q: 'ritmo' });
    expect(parsed).toEqual({
      q: 'ritmo',
      mode: 'all',
      limit: 10,
      offset: 0,
      filters: {
        concepts: [],
        genres: [],
        depths: [],
        relevances: [],
        authorships: [],
        topics: [],
      },
    });
  });

  it('rejects a blank question', () => {
    expect(searchRequestSchema.safeParse({ q: '   ' }).success).toBe(false);
  });

  it('accepts facet filters and rejects unknown facet values', () => {
    const ok = searchRequestSchema.safeParse({
      q: 'x',
      filters: { genres: ['paper'], depths: [2] },
    });
    expect(ok.success).toBe(true);
    expect(
      searchRequestSchema.safeParse({ q: 'x', filters: { genres: ['poem'] } })
        .success,
    ).toBe(false);
    expect(
      searchRequestSchema.safeParse({ q: 'x', filters: { path: 'x' } }).success,
    ).toBe(false);
  });

  it('filters by authorship and refuses unknown groups (KBC-020)', () => {
    const parsed = searchRequestSchema.parse({
      q: 'x',
      filters: { authorships: ['mestre-laercio'] },
    });
    expect(parsed.filters.authorships).toEqual(['mestre-laercio']);
    expect(
      searchRequestSchema.safeParse({
        q: 'x',
        filters: { authorships: ['laercio'] },
      }).success,
    ).toBe(false);
  });

  it('rejects unknown fields', () => {
    const result = searchRequestSchema.safeParse({ q: 'x', path: '/etc' });
    expect(result.success).toBe(false);
  });
});

describe('topicSlugSchema', () => {
  it('accepts nested topic ids', () => {
    expect(topicSlugSchema.safeParse('harness/goclaw').success).toBe(true);
  });

  it('rejects traversal', () => {
    expect(topicSlugSchema.safeParse('../etc').success).toBe(false);
  });
});
