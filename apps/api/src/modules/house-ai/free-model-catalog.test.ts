import { describe, expect, it, vi } from 'vitest';
import type {
  OpenRouterAccountPort,
  OpenRouterModel,
} from '../../ports/openrouter-account.js';
import { FREE_MODELS_TTL_MS, FreeModelCatalog } from './free-model-catalog.js';

const model = (
  id: string,
  extra: Partial<OpenRouterModel> = {},
): OpenRouterModel => ({
  id,
  name: id,
  contextLength: 1000,
  tools: true,
  price: { input: 0, output: 0 },
  ...extra,
});

const unused = async (): Promise<never> => {
  throw new Error('not used here');
};

const accountWith = (
  load: () => Promise<readonly OpenRouterModel[]>,
): OpenRouterAccountPort & { models: ReturnType<typeof vi.fn> } => ({
  models: vi.fn(load),
  freeUsage: unused,
  exchangeCode: unused,
  createKey: unused,
  updateKeyLimit: unused,
  deleteKey: unused,
});

describe('FreeModelCatalog (KBC-022 AC-3)', () => {
  const list = [
    model('paid/model', { price: { input: 1e-6, output: 2e-6 } }),
    model('small:free', { contextLength: 8000 }),
    model('notools:free', { tools: false }),
    model('big:free', { contextLength: 128000 }),
  ];

  it('keeps only free models with tools, largest context first, and the router last', async () => {
    const catalog = new FreeModelCatalog({
      account: accountWith(async () => list),
    });
    const view = await catalog.list();
    expect(view.items.map((m) => m.id)).toEqual(['big:free', 'small:free']);
    expect(view.stale).toBe(false);
    expect(catalog.autoChain(true)).toEqual([
      'big:free',
      'small:free',
      'openrouter/free',
    ]);
    expect(catalog.autoChain(false)).toEqual(['big:free', 'small:free']);
    expect(catalog.priceOf('paid/model')).toEqual({
      input: 1e-6,
      output: 2e-6,
    });
    expect(catalog.priceOf('unknown')).toBeNull();
  });

  it('refreshes once a day and keeps the last list when a refresh fails', async () => {
    let now = 0;
    let fail = false;
    const account = accountWith(async () => {
      if (fail) throw new Error('down');
      return list;
    });
    const warnings: string[] = [];
    const catalog = new FreeModelCatalog({
      account,
      now: () => now,
      warn: (m) => warnings.push(m),
    });
    await catalog.list();
    now = FREE_MODELS_TTL_MS - 1;
    await catalog.list();
    expect(account.models).toHaveBeenCalledTimes(1);
    now = FREE_MODELS_TTL_MS;
    fail = true;
    const view = await catalog.list();
    expect(view.stale).toBe(true);
    expect(view.items).toHaveLength(2);
    expect(warnings).toEqual(['OpenRouter model list refresh failed: down']);
    await catalog.list();
    expect(account.models).toHaveBeenCalledTimes(2);
  });

  it('reports a list never loaded', async () => {
    const catalog = new FreeModelCatalog({
      account: accountWith(async () => {
        throw new Error('offline');
      }),
    });
    expect(await catalog.list()).toEqual({
      items: [],
      updatedAt: null,
      stale: true,
    });
  });
});
