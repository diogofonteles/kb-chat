import { describe, expect, it } from 'vitest';
import { searchRequestSchema } from './search.js';
import { topicSlugSchema } from './topics.js';

describe('searchRequestSchema', () => {
  it('defaults the mode to all and the limit to 10', () => {
    const parsed = searchRequestSchema.parse({ q: 'ritmo' });
    expect(parsed).toEqual({ q: 'ritmo', mode: 'all', limit: 10 });
  });

  it('rejects a blank question', () => {
    expect(searchRequestSchema.safeParse({ q: '   ' }).success).toBe(false);
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
