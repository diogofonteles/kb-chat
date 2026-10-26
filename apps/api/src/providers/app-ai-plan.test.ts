import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { MemoryDocumentStore } from '../adapters/memory-document-store.js';
import { MemorySpendLedger } from '../adapters/memory-spend-ledger.js';
import { MemoryHouseUsage } from '../adapters/house-usage-ledgers.js';
import { OpenRouterAccountClient } from '../adapters/openrouter-account-client.js';
import { SecretBox } from '../adapters/secret-box.js';
import {
  FreeModelCatalog,
  HouseAiService,
  HouseQuota,
} from '../modules/house-ai/index.js';
import type { ResearchRunnerPort } from '../ports/research-runner.js';
import { FakeOpenRouter } from '../testing/fake-openrouter.js';
import { AppAiPlan } from './app-ai-plan.js';
import { PaidMeters } from './paid-meters.js';

async function setup() {
  const fake = new FakeOpenRouter();
  const account = new OpenRouterAccountClient({ fetch: fake.fetch });
  const catalog = new FreeModelCatalog({ account });
  const house = new HouseAiService({
    store: new MemoryDocumentStore(),
    sealer: new SecretBox(randomBytes(32)),
    account,
    catalog,
  });
  await house.update({ key: 'sk-or-v1-house-valid' }, 'm');
  const meters = new PaidMeters();
  const idle: ResearchRunnerPort = {
    model: 'm',
    billing: 'per-token',
    configured: () => true,
    run: async function* () {
      yield {
        type: 'done',
        usd: 0,
        billing: 'per-token',
        model: 'm',
        interrupted: false,
        steps: 0,
      };
    },
  };
  const plan = new AppAiPlan({
    house,
    catalog,
    quota: new HouseQuota({ ledger: new MemoryHouseUsage() }),
    houseSpend: new MemorySpendLedger(),
    personOf: () => null,
    perTokenRunner: () => idle,
    fetch: fake.fetch,
    meters,
  });
  return { plan, meters };
}

describe('AppAiPlan meters (review round 2)', () => {
  it('opens a paid meter only while a turn runs, never for a readiness check', async () => {
    const { plan, meters } = await setup();
    const runner = plan.runner('p', 'fast');
    for (let i = 0; i < 5; i++) expect(runner.configured()).toBe(true);
    expect(meters.openCount('p')).toBe(0);
    const events = [];
    for await (const event of runner.run({
      topic: 't',
      question: 'q',
      history: [],
      profile: 'fast',
      signal: new AbortController().signal,
    }))
      events.push(event);
    expect(events.at(-1)).toMatchObject({ type: 'done', plan: 'house' });
    expect(meters.openCount('p')).toBe(0);
  });
});
