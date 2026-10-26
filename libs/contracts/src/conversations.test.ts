import { describe, expect, it } from 'vitest';
import {
  conversationSchema,
  savedResearchTurnSchema,
  summarizeConversation,
  type Conversation,
} from './conversations.js';
import { EMPTY_FILTERS } from './search.js';

const base = {
  id: '6f1c2b9b-8a11-4d0a-9d55-0b6f1f0e6a3e',
  topic: 'hermetismo',
  title: 'lei do ritmo',
  createdAt: '2026-10-24T12:00:00.000Z',
  updatedAt: '2026-10-24T12:05:00.000Z',
};

const search: Conversation = {
  kind: 'search',
  ...base,
  asks: [
    { question: 'lei do ritmo', mode: 'all', filters: EMPTY_FILTERS, total: 3 },
    { question: 'polaridade', mode: 'exact', filters: EMPTY_FILTERS, total: 0 },
  ],
};

const research: Conversation = {
  kind: 'research',
  ...base,
  turns: [
    {
      question: 'lei do ritmo',
      answer: 'Tudo flui.',
      sources: [],
      steps: 3,
      usd: 0.01,
      billing: 'per-token',
      model: 'stub',
      interrupted: false,
      at: '2026-10-24T12:05:00.000Z',
    },
  ],
};

describe('conversations contract', () => {
  it('summarizes both kinds with their question count', () => {
    expect(summarizeConversation(search)).toEqual({
      id: base.id,
      kind: 'search',
      topic: 'hermetismo',
      title: 'lei do ritmo',
      updatedAt: base.updatedAt,
      count: 2,
    });
    expect(summarizeConversation(research).count).toBe(1);
  });

  it('reads turns saved before billing existed as per-token ones', () => {
    const legacy = {
      question: 'lei do ritmo',
      answer: 'Tudo flui.',
      sources: [],
      steps: 3,
      usd: 0.01,
      model: 'stub',
      interrupted: false,
      at: '2026-10-24T12:05:00.000Z',
    };
    const parsed = conversationSchema.parse({ ...research, turns: [legacy] });
    expect(parsed.kind === 'research' && parsed.turns[0]?.billing).toBe(
      'per-token',
    );
  });

  it('refuses a conversation whose id is not a uuid or that has no questions', () => {
    expect(conversationSchema.safeParse(search).success).toBe(true);
    expect(
      conversationSchema.safeParse({ ...search, id: '../etc/passwd' }).success,
    ).toBe(false);
    expect(conversationSchema.safeParse({ ...search, asks: [] }).success).toBe(
      false,
    );
  });

  it('keeps that a research turn went deeper, and reads older turns without it (ADR 0009)', () => {
    const turn = {
      question: 'q',
      answer: 'a',
      sources: [],
      steps: 9,
      usd: 0,
      billing: 'subscription',
      model: 'opus',
      interrupted: false,
      at: '2026-10-24T19:00:00.000Z',
    };
    expect(
      savedResearchTurnSchema.parse({ ...turn, escalated: true }).escalated,
    ).toBe(true);
    expect(savedResearchTurnSchema.parse(turn).escalated).toBeUndefined();
  });

  it('keeps the research profile of a turn, optional for older turns (KBC-017 FR-11)', () => {
    const turn = {
      question: 'q',
      answer: 'a',
      sources: [],
      steps: 40,
      usd: 0,
      billing: 'subscription',
      model: 'opus',
      interrupted: false,
      at: '2026-10-25T19:00:00.000Z',
    };
    expect(
      savedResearchTurnSchema.parse({ ...turn, profile: 'exhaustive' }).profile,
    ).toBe('exhaustive');
    expect(savedResearchTurnSchema.parse(turn).profile).toBeUndefined();
  });
});
