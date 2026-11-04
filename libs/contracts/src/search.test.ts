import { describe, expect, it } from 'vitest';
import { searchRequestSchema, searchResponseSchema } from './search.js';
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
      kinds: ['text', 'audio'],
    });
  });

  it('KBC-039: accepts the kinds to search and never none of them (BR-4)', () => {
    expect(
      searchRequestSchema.parse({ q: 'x', kinds: ['audio'] }).kinds,
    ).toEqual(['audio']);
    expect(searchRequestSchema.safeParse({ q: 'x', kinds: [] }).success).toBe(
      false,
    );
    expect(
      searchRequestSchema.safeParse({ q: 'x', kinds: ['video'] }).success,
    ).toBe(false);
    expect(
      searchRequestSchema.safeParse({ q: 'x', kinds: ['text', 'text'] })
        .success,
    ).toBe(false);
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

describe('searchResponseSchema (KBC-039)', () => {
  const base = {
    items: [],
    total: 0,
    capped: false,
    nextOffset: null,
    hiddenOffTopic: 0,
    facets: {
      concepts: [],
      genres: [],
      depths: [],
      relevances: [],
      authorships: [],
      topics: [],
    },
    mode: 'all',
    tookMs: 1,
  };

  it('reads an answer of an API without spoken passages as texts only', () => {
    const parsed = searchResponseSchema.parse(base);
    expect(parsed.media).toEqual([]);
    expect(parsed.kinds).toEqual({ text: 0, audio: null });
  });

  it('keeps a spoken passage with its highlights and minute', () => {
    const hit = {
      mediaId: '6f1c2b9b-8a11-4d0a-9d55-0b6f1f0e6a3e',
      topic: 'udv',
      title: 'Palestra',
      authorship: 'outros-autores',
      author: null,
      text: 'Hoasca',
      highlights: [{ start: 0, end: 6 }],
      startMs: 495_000,
      endMs: 499_000,
      confidence: 'low',
      score: 0.4,
    };
    const parsed = searchResponseSchema.parse({
      ...base,
      media: [hit],
      kinds: { text: 0, audio: 1 },
    });
    expect(parsed.media).toEqual([{ ...hit, match: 'speech', subjects: [] }]);
    expect(
      searchResponseSchema.safeParse({ ...base, media: [{ ...hit, score: 2 }] })
        .success,
    ).toBe(false);
  });
});
