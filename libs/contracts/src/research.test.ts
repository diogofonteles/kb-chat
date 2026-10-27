import { describe, expect, it } from 'vitest';
import {
  MAX_HISTORY_TURNS,
  modelProfileOf,
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

  it('takes the fast, deep or exhaustive profile and nothing else (KBC-011, KBC-017)', () => {
    expect(
      researchRequestSchema.parse({ question: 'x', profile: 'deep' }).profile,
    ).toBe('deep');
    expect(
      researchRequestSchema.parse({ question: 'x', profile: 'exhaustive' })
        .profile,
    ).toBe('exhaustive');
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
        model: 'opus',
        interrupted: false,
        steps: 9,
        escalated: true,
      },
      {
        type: 'step',
        step: { kind: 'deepen', text: 'Aprofundando a pesquisa…' },
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

  it('runs the exhaustive profile on the deep model (KBC-017 BR-3)', () => {
    expect(modelProfileOf('fast')).toBe('fast');
    expect(modelProfileOf('deep')).toBe('deep');
    expect(modelProfileOf('exhaustive')).toBe('deep');
  });

  it('marks the steps of a sub-researcher and the delegation itself (KBC-018)', () => {
    const step = researchEventSchema.parse({
      type: 'step',
      step: { kind: 'search', text: 'Procurando “livro”', agent: 2 },
    });
    expect(step).toMatchObject({ step: { agent: 2 } });
    expect(
      researchEventSchema.safeParse({
        type: 'step',
        step: { kind: 'delegate', text: 'Delegando: varrer os livros' },
      }).success,
    ).toBe(true);
    expect(
      researchEventSchema.safeParse({
        type: 'step',
        step: { kind: 'search', text: 'x', agent: 0 },
      }).success,
    ).toBe(false);
  });

  it('KBC-029: takes the conversation and turn ids together, or neither', () => {
    const conversationId = '6f1c2b9b-8a11-4d0a-9d55-0b6f1f0e6a3e';
    const turnId = '0b9d7c1e-3f2a-4c5b-8d6e-7f8091a2b3c4';
    expect(
      researchRequestSchema.parse({ question: 'x', conversationId, turnId }),
    ).toMatchObject({ conversationId, turnId });
    expect(
      researchRequestSchema.safeParse({ question: 'x', conversationId })
        .success,
    ).toBe(false);
    expect(
      researchRequestSchema.safeParse({ question: 'x', turnId: 'nope' })
        .success,
    ).toBe(false);
  });
});
