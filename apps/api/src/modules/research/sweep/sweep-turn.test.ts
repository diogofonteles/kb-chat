import { describe, expect, it } from 'vitest';
import { MemoryVault, memoryTools } from '../../../../test/memory-research.js';
import { researchBudgets } from '../limits.js';
import { SourceBook } from '../source-book.js';
import { sweepTurnHost } from './sweep-turn.js';

async function host(input: { requestBudget?: number } = {}) {
  const tools = await memoryTools(new MemoryVault({}));
  return sweepTurnHost({
    kit: {
      sweeps: tools.sweeps,
      book: new SourceBook(),
      topicTitle: 'T',
      mainAuthor: null,
    },
    input: {
      topic: 'hermetismo',
      question: 'q',
      history: [],
      profile: 'exhaustive',
      signal: new AbortController().signal,
      ...input,
    },
    engine: { free: false, parallel: 1, extract: async () => '' },
    budget: researchBudgets({ sweepRequests: 100 }).exhaustive,
    startedAt: 1_000,
    requestsBefore: 3,
    answer: async function* () {
      yield* [];
    },
  });
}

describe('sweepTurnHost (code review rounds 1 and 2)', () => {
  it('counts the time ceiling from the turn’s start, for every runner', async () => {
    expect((await host()).deadline).toBe(1_000 + 30 * 60_000);
  });

  it('caps the requests at the budget and at what the house lends', async () => {
    expect((await host()).maxRequests).toBe(100);
    expect((await host({ requestBudget: 40 })).maxRequests).toBe(40);
  });
});
