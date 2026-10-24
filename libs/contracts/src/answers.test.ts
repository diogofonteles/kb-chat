import { describe, expect, it } from 'vitest';
import {
  answerEventSchema,
  answerRequestSchema,
  spendTodaySchema,
} from './answers.js';

describe('answer contracts', () => {
  it('defaults the search of an answer request', () => {
    expect(answerRequestSchema.parse({ q: 'ritmo' })).toEqual({
      q: 'ritmo',
      mode: 'all',
      filters: { concepts: [], genres: [], depths: [], relevances: [] },
    });
  });

  it('accepts each streamed event type and rejects unknown ones', () => {
    for (const event of [
      { type: 'sources', sources: [{ n: 1, id: 'a.md', title: 'A' }] },
      { type: 'token', text: 'x' },
      { type: 'done', usd: 0.001, model: 'm', interrupted: false },
      { type: 'error', code: 'INTERNAL' },
    ]) {
      expect(answerEventSchema.parse(event)).toEqual(event);
    }
    expect(answerEventSchema.safeParse({ type: 'other' }).success).toBe(false);
  });

  it('describes today’s spend', () => {
    expect(
      spendTodaySchema.parse({ usd: 0, capUsd: 1, configured: true })
        .configured,
    ).toBe(true);
  });
});
