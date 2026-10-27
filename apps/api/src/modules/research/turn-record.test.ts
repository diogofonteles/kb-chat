import type { ResearchEvent, SavedResearchTurn } from '@kb-chat/contracts';
import { describe, expect, it } from 'vitest';
import { pendingTurn, recordTurn } from './turn-record.js';

const SOURCE = { n: 1, id: 'raw/a.md', title: 'Os Princípios' };
const AT = '2026-10-27T12:00:00.000Z';

const pending = (): SavedResearchTurn =>
  pendingTurn({
    id: '0b9d7c1e-3f2a-4c5b-8d6e-7f8091a2b3c4',
    question: 'quais são os 5 princípios',
    profile: 'deep',
    at: AT,
  });

const done = (
  overrides: Partial<Extract<ResearchEvent, { type: 'done' }>> = {},
): ResearchEvent => ({
  type: 'done',
  usd: 0.004,
  billing: 'per-token',
  model: 'deep/model',
  interrupted: false,
  steps: 3,
  ...overrides,
});

describe('pendingTurn', () => {
  it('starts with no answer, the question, its id and profile, marked pending', () => {
    expect(pending()).toEqual({
      id: '0b9d7c1e-3f2a-4c5b-8d6e-7f8091a2b3c4',
      question: 'quais são os 5 princípios',
      answer: '',
      sources: [],
      steps: 0,
      usd: 0,
      billing: 'per-token',
      model: '',
      interrupted: false,
      profile: 'deep',
      status: 'pending',
      at: AT,
    });
  });
});

describe('recordTurn', () => {
  it('records an answered turn without the retracted thought, with its sources and cost', () => {
    const events: ResearchEvent[] = [
      { type: 'start', model: 'fast/model', billing: 'per-token' },
      { type: 'token', text: 'Vou ler. ', segment: 0 },
      { type: 'retract', segment: 0 },
      { type: 'step', step: { kind: 'read', text: 'Lendo' } },
      { type: 'sources', sources: [SOURCE] },
      { type: 'token', text: 'São cinco ', segment: 1 },
      { type: 'token', text: '[1].', segment: 1 },
      done({ escalated: true, plan: 'house' }),
    ];
    const turn = recordTurn(pending(), events);
    expect(turn).toMatchObject({
      answer: 'São cinco [1].',
      sources: [SOURCE],
      steps: 3,
      usd: 0.004,
      model: 'deep/model',
      interrupted: false,
      escalated: true,
      plan: 'house',
      profile: 'deep',
    });
    expect(turn).not.toHaveProperty('status');
    expect(turn).not.toHaveProperty('error');
  });

  it('records a stopped turn as interrupted, with the text it had', () => {
    const turn = recordTurn(pending(), [
      { type: 'token', text: 'Meia', segment: 0 },
      done({ interrupted: true, usd: 0.001 }),
    ]);
    expect(turn).toMatchObject({ answer: 'Meia', interrupted: true });
    expect(turn).not.toHaveProperty('status');
  });

  it('records an error event as a failed turn with its code', () => {
    const turn = recordTurn(pending(), [
      { type: 'start', model: 'm', billing: 'free' },
      { type: 'error', code: 'HOUSE_QUOTA_EXHAUSTED', limit: 3 },
    ]);
    expect(turn).toMatchObject({
      status: 'failed',
      error: 'HOUSE_QUOTA_EXHAUSTED',
      billing: 'free',
    });
  });

  it('records a finished turn with no text as failed, like the page does', () => {
    expect(recordTurn(pending(), [done()])).toMatchObject({
      status: 'failed',
      error: 'INTERNAL',
    });
  });

  it('records a stream that ended without "done": interrupted with text, failed without', () => {
    expect(
      recordTurn(pending(), [{ type: 'token', text: 'Parte', segment: 0 }]),
    ).toMatchObject({ interrupted: true, answer: 'Parte' });
    expect(recordTurn(pending(), [])).toMatchObject({
      status: 'failed',
      error: 'INTERNAL',
    });
  });
});
