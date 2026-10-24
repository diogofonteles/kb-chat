import { describe, expect, it } from 'vitest';
import {
  MAX_HISTORY_TURNS,
  researchEventSchema,
  researchRequestSchema,
} from './research.js';

describe('research contracts', () => {
  it('trims the question and defaults the history to empty', () => {
    expect(researchRequestSchema.parse({ question: '  ritmo  ' })).toEqual({
      question: 'ritmo',
      history: [],
      profile: 'fast',
    });
  });

  it('takes the fast or the deep profile and nothing else (KBC-011)', () => {
    expect(
      researchRequestSchema.parse({ question: 'x', profile: 'deep' }).profile,
    ).toBe('deep');
    expect(
      researchRequestSchema.safeParse({ question: 'x', profile: 'max' })
        .success,
    ).toBe(false);
  });

  it('refuses an empty question, unknown fields and a history over the cap', () => {
    expect(researchRequestSchema.safeParse({ question: ' ' }).success).toBe(
      false,
    );
    expect(
      researchRequestSchema.safeParse({ question: 'x', mode: 'all' }).success,
    ).toBe(false);
    const turn = { question: 'q', answer: 'a' };
    const history = Array.from({ length: MAX_HISTORY_TURNS + 1 }, () => turn);
    expect(
      researchRequestSchema.safeParse({ question: 'x', history }).success,
    ).toBe(false);
  });

  it('parses every event of the stream', () => {
    const events = [
      { type: 'step', step: { kind: 'search', text: 'Buscando “ritmo”' } },
      { type: 'sources', sources: [{ n: 1, id: 'a.md', title: 'A' }] },
      { type: 'token', text: 'Segundo o acervo [1].', segment: 0 },
      { type: 'retract', segment: 0 },
      {
        type: 'done',
        usd: 0.01,
        billing: 'per-token',
        model: 'm',
        interrupted: false,
        steps: 3,
      },
      {
        type: 'done',
        usd: 0,
        billing: 'subscription',
        model: 'claude',
        interrupted: false,
        steps: 2,
      },
      { type: 'error', code: 'DAILY_CAP_REACHED' },
    ];
    for (const event of events)
      expect(researchEventSchema.parse(event)).toEqual(event);
    expect(
      researchEventSchema.safeParse({
        type: 'step',
        step: { kind: 'write', text: '' },
      }).success,
    ).toBe(false);
    expect(
      researchEventSchema.safeParse({ type: 'retract', segment: -1 }).success,
    ).toBe(false);
  });
});
