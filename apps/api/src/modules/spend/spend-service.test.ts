import { describe, expect, it } from 'vitest';
import { MemorySpendLedger } from '../../adapters/memory-spend-ledger.js';
import { StubLlmAdapter } from '../../adapters/stub-llm-adapter.js';
import type { LlmPort } from '../../ports/llm.js';
import { SpendService } from './spend-service.js';

const subscription: LlmPort = {
  model: 'plan/model',
  billing: 'subscription',
  configured: () => true,
  price: async () => ({ input: 1, output: 1 }),
  balance: async () => 0,
  stream: async function* () {
    yield* [];
  },
};

const service = (llm: LlmPort, dailyCapUsd = 1) => {
  const ledger = new MemorySpendLedger();
  return {
    ledger,
    spend: new SpendService({
      llm,
      ledger,
      dailyCapUsd: () => dailyCapUsd,
      principal: 'owner',
    }),
  };
};

describe('SpendService', () => {
  it('estimates a call from the prompt and the whole output budget', async () => {
    const { spend } = service(new StubLlmAdapter());
    expect(await spend.estimate('x'.repeat(35), 100)).toBeCloseTo(110e-6, 12);
  });

  it('prices reported and unreported usage and records one ledger entry', async () => {
    const { spend, ledger } = service(new StubLlmAdapter());
    expect(
      await spend.costOf({ inputTokens: 1, outputTokens: 1, usd: 0.5 }),
    ).toBe(0.5);
    expect(
      await spend.costOf({ inputTokens: 10, outputTokens: 5, usd: null }),
    ).toBeCloseTo(15e-6, 12);
    await spend.record({
      inputTokens: 1,
      outputTokens: 2,
      usd: 0.3,
      interrupted: false,
    });
    expect(ledger.entries[0]).toMatchObject({
      principal: 'owner',
      model: 'stub/model',
      usd: 0.3,
    });
    expect(await spend.today()).toEqual({
      usd: 0.3,
      capUsd: 1,
      configured: true,
    });
  });

  it('refuses over the cap or the credit', async () => {
    const capped = service(new StubLlmAdapter(), 0.1);
    await expect(capped.spend.guard(0.2)).rejects.toMatchObject({
      code: 'DAILY_CAP_REACHED',
    });
    const broke = service(new StubLlmAdapter({ balance: 0.01 }));
    await expect(broke.spend.guard(0.02)).rejects.toMatchObject({
      code: 'LLM_INSUFFICIENT_CREDIT',
    });
    await expect(broke.spend.guard(0.001)).resolves.toBeUndefined();
  });

  it('costs nothing, never refuses and records nothing on a subscription', async () => {
    const { spend, ledger } = service(subscription, 0);
    expect(await spend.estimate('long prompt', 2000)).toBe(0);
    await expect(spend.guard(5)).resolves.toBeUndefined();
    expect(
      await spend.costOf({ inputTokens: 9, outputTokens: 9, usd: 3 }),
    ).toBe(0);
    await spend.record({
      inputTokens: 9,
      outputTokens: 9,
      usd: 0,
      interrupted: false,
    });
    expect(ledger.entries).toEqual([]);
  });

  it('reads the cap and the availability on every call', async () => {
    let cap = 1;
    let available = false;
    const ledger = new MemorySpendLedger();
    const spend = new SpendService({
      llm: new StubLlmAdapter(),
      ledger,
      dailyCapUsd: () => cap,
      configured: () => available,
      principal: 'owner',
    });
    expect(await spend.today()).toMatchObject({ capUsd: 1, configured: false });
    cap = 0.1;
    available = true;
    expect(await spend.today()).toMatchObject({
      capUsd: 0.1,
      configured: true,
    });
    await expect(spend.guard(0.2)).rejects.toMatchObject({
      code: 'DAILY_CAP_REACHED',
    });
  });
});
