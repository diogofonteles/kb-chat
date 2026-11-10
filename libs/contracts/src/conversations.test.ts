import { describe, expect, it } from 'vitest';
import {
  conversationSchema,
  isRestrictedSource,
  pairTurns,
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

  it('keeps the authorship of saved sources and reads older ones without it (KBC-020 AC-8)', () => {
    const turn = {
      question: 'q',
      answer: 'a [1][2]',
      steps: 2,
      usd: 0,
      model: 'stub',
      interrupted: false,
      at: '2026-10-26T12:00:00.000Z',
    };
    const saved = savedResearchTurnSchema.parse({
      ...turn,
      sources: [
        {
          n: 1,
          id: 'raw/a.md',
          title: 'A',
          authorship: 'mestre-laercio',
          author: 'José Laércio do Egito',
        },
        { n: 2, id: 'raw/b.md', title: 'B', authorship: 'outros-autores' },
      ],
    });
    expect(saved.sources).toMatchObject([
      { authorship: 'mestre-laercio', author: 'José Laércio do Egito' },
      { authorship: 'outros-autores' },
    ]);
    const old = savedResearchTurnSchema.parse({
      ...turn,
      sources: [{ n: 1, id: 'raw/a.md', title: 'A' }],
    });
    expect(old.sources[0]).not.toHaveProperty('authorship');
  });

  it('KBC-110: reads a restricted source as its number only, and older turns without a count', () => {
    const turn = {
      question: 'q',
      answer: 'a [1][2]',
      steps: 2,
      usd: 0,
      model: 'stub',
      interrupted: false,
      at: '2026-11-10T12:00:00.000Z',
    };
    const saved = savedResearchTurnSchema.parse({
      ...turn,
      sources: [
        { n: 1, id: 'raw/a.md', title: 'A' },
        { n: 2, restricted: true },
      ],
      restrictedSources: 1,
    });
    expect(saved.sources.map(isRestrictedSource)).toEqual([false, true]);
    expect(saved.restrictedSources).toBe(1);
    expect(
      savedResearchTurnSchema.safeParse({
        ...turn,
        sources: [{ n: 2, restricted: true, title: 'Velado' }],
      }).success,
    ).toBe(false);
    expect(
      savedResearchTurnSchema.parse({ ...turn, sources: [] }).restrictedSources,
    ).toBeUndefined();
  });

  it('reads a search saved before the authorship filter existed (KBC-020 AC-8)', () => {
    const oldFilters = { concepts: [], genres: [], depths: [], relevances: [] };
    const parsed = conversationSchema.parse({
      ...search,
      asks: [{ question: 'q', mode: 'all', filters: oldFilters, total: 1 }],
    });
    expect(
      parsed.kind === 'search' && parsed.asks[0]?.filters.authorships,
    ).toEqual([]);
  });

  it('KBC-029: keeps a pending and a failed turn, and says so in the summary', () => {
    const [turn] = research.kind === 'research' ? research.turns : [];
    const pending = { ...turn, id: base.id, status: 'pending', answer: '' };
    const failed = {
      ...turn,
      id: base.id,
      status: 'failed',
      error: 'INTERNAL',
    };
    const withTurn = (t: unknown) =>
      conversationSchema.parse({ ...research, turns: [t] });
    expect(summarizeConversation(withTurn(pending)).status).toBe('pending');
    expect(summarizeConversation(withTurn(failed)).status).toBe('failed');
    expect(
      summarizeConversation(withTurn({ ...turn, interrupted: true })).status,
    ).toBe('interrupted');
    expect(summarizeConversation(research)).not.toHaveProperty('status');
    expect(summarizeConversation(search)).not.toHaveProperty('status');
    expect(
      savedResearchTurnSchema.safeParse({ ...turn, status: 'running' }).success,
    ).toBe(false);
  });

  it('KBC-110: pairs turns by id first, then by start and question, each known turn once', () => {
    const at = '2026-11-10T12:00:00.000Z';
    const a = { id: '0b9d7c1e-3f2a-4c5b-8d6e-7f8091a2b3c4', at, question: 'q' };
    const b = { id: '1c8e6d2f-4a3b-4d6c-9e7f-8091a2b3c4d5', at, question: 'q' };
    const later = { at: '2026-11-10T12:01:00.000Z', question: 'r' };

    // Same id wins over an earlier turn with the same start.
    expect(pairTurns([b], [a, b])).toEqual([b]);
    // Another id, or none, falls back to the start (QA R2-17, R2-20).
    expect(pairTurns([{ ...a, id: undefined }], [a])).toEqual([a]);
    expect(
      pairTurns([{ ...a, id: '2d9f7e3a-5b4c-4e7d-8f9a-a1b2c3d4e5f6' }], [a]),
    ).toEqual([a]);
    // Two of one start pair in order, once each (QA R2-16).
    expect(
      pairTurns(
        [
          { at, question: 'q' },
          { at, question: 'q' },
        ],
        [a, b],
      ),
    ).toEqual([a, b]);
    expect(pairTurns([later, { at, question: 'q' }], [a])).toEqual([
      undefined,
      a,
    ]);
  });
});
