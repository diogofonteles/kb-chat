import { randomBytes } from 'node:crypto';
import { DEFAULT_PERSON_AI } from '@kb-chat/contracts';
import { describe, expect, it } from 'vitest';
import { MemoryDocumentStore } from '../../adapters/memory-document-store.js';
import { OpenRouterAccountClient } from '../../adapters/openrouter-account-client.js';
import { SecretBox } from '../../adapters/secret-box.js';
import { FakeOpenRouter } from '../../testing/fake-openrouter.js';
import { FreeModelCatalog } from './free-model-catalog.js';
import { FREE_USAGE_TTL_MS, HouseAiService } from './house-ai-service.js';

async function setup(fetchImpl?: typeof fetch) {
  const fake = new FakeOpenRouter();
  const account = new OpenRouterAccountClient({
    fetch: fetchImpl ?? fake.fetch,
  });
  let now = new Date('2026-10-26T12:00:00Z');
  const store = new MemoryDocumentStore();
  const warnings: string[] = [];
  const service = new HouseAiService({
    store,
    sealer: new SecretBox(randomBytes(32)),
    account,
    catalog: new FreeModelCatalog({ account }),
    now: () => now,
    warn: (m) => warnings.push(m),
  });
  await service.load();
  return {
    fake,
    service,
    store,
    warnings,
    advance: (ms: number) => (now = new Date(now.getTime() + ms)),
  };
}

const holder = { id: 'p1', email: 'p1@example.com' };
const paid = (enabled: boolean, cap = 1) => ({
  ...DEFAULT_PERSON_AI,
  paidFallback: { enabled, monthlyCapUsd: cap },
});

describe('HouseAiService', () => {
  it('ignores an invalid file with a warning and starts with the defaults', async () => {
    const { service, store, warnings } = await setup();
    await store.write({ version: 7 });
    await service.load();
    expect(warnings).toEqual(['house-ai.json is invalid; ignored']);
    expect(service.defaultAppAi()).toBe('house');
    expect(service.defaultDailyResearches()).toBe(5);
    expect(service.isConnected()).toBe(false);
  });

  it('uses the master’s free models in order, the router last when wanted', async () => {
    const { service } = await setup();
    await service.update(
      { freeModels: ['b:free', 'openrouter/free', 'a:free'] },
      'm',
    );
    expect(service.chain()).toEqual(['b:free', 'a:free', 'openrouter/free']);
    await service.update({ includeRouter: false }, 'm');
    expect(service.chain()).toEqual(['b:free', 'a:free']);
  });

  it('reads the free counter at most once a minute', async () => {
    const { fake, service, advance } = await setup();
    await service.update({ key: 'sk-or-v1-house-valid' }, 'm');
    expect(await service.freeUsage()).toMatchObject({ remaining: 1000 });
    fake.freeRemaining = 3;
    expect(await service.freeUsage()).toMatchObject({ remaining: 1000 });
    advance(FREE_USAGE_TTL_MS);
    expect(await service.freeUsage()).toMatchObject({ remaining: 3 });
  });

  it('reports a refused key and an unreachable OpenRouter on test', async () => {
    const { service } = await setup();
    await service.update({ key: 'sk-or-v1-unknown' }, 'm');
    expect((await service.test()).code).toBe('LLM_KEY_REJECTED');
    const down = await setup(async () => {
      throw new Error('down');
    });
    await down.service.update({ key: 'sk-or-v1-house-valid' }, 'm');
    expect((await down.service.test()).code).toBe('PROVIDER_UNAVAILABLE');
  });

  it('does not provision without a management key, and refuses when OpenRouter fails', async () => {
    const { fake, service } = await setup();
    await service.beforePersonAiChange(holder, paid(true));
    expect(fake.createdKeys.size).toBe(0);
    const failing = await setup(async (input, init) =>
      String(input).endsWith('/keys')
        ? new Response(null, { status: 500 })
        : new FakeOpenRouter().fetch(input, init),
    );
    await failing.service.update({ managementKey: 'sk-or-v1-mgmt-x' }, 'm');
    await expect(
      failing.service.beforePersonAiChange(holder, paid(true)),
    ).rejects.toMatchObject({
      code: 'PROVIDER_UNAVAILABLE',
    });
  });

  it('uses a person’s provisioned key for their requests, the house key otherwise', async () => {
    const { service } = await setup();
    await service.update(
      { key: 'sk-or-v1-house-valid', managementKey: 'mgmt-key-1' },
      'm',
    );
    await service.beforePersonAiChange(holder, paid(true, 2));
    expect(service.keyFor('p1')).toMatch(/^sk-or-v1-person-/);
    expect(service.keyFor('p2')).toBe('sk-or-v1-house-valid');
    expect(service.keyFor(null)).toBe('sk-or-v1-house-valid');
    const view = await service.view();
    expect(view.managementKey).toEqual({ set: true, last4: 'ey-1' });
    await service.update({ managementKey: null }, 'm');
    expect((await service.view()).managementKey).toBeNull();
  });
});
