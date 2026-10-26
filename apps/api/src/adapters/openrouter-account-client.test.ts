import { describe, expect, it, vi } from 'vitest';
import { LlmKeyRejectedError } from '../ports/llm-errors.js';
import { OpenRouterAccountClient } from './openrouter-account-client.js';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status });

describe('OpenRouterAccountClient', () => {
  it('reads the public model list with tools and prices', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      json({
        data: [
          {
            id: 'a/one:free',
            name: 'One (free)',
            context_length: 1000,
            pricing: { prompt: '0', completion: '0' },
            supported_parameters: ['tools', 'max_tokens'],
          },
          {
            id: 'b/two',
            pricing: { prompt: '0.000001', completion: '0.000002' },
          },
        ],
      }),
    );
    const models = await new OpenRouterAccountClient({
      fetch: fetchMock,
    }).models();
    expect(models).toEqual([
      {
        id: 'a/one:free',
        name: 'One (free)',
        contextLength: 1000,
        tools: true,
        price: { input: 0, output: 0 },
      },
      {
        id: 'b/two',
        name: 'b/two',
        contextLength: null,
        tools: false,
        price: { input: 1e-6, output: 2e-6 },
      },
    ]);
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      'https://openrouter.ai/api/v1/models',
    );
  });

  it('reads today’s free requests with the key in the header only', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      json({
        data: {
          free_model_daily_requests: { used: 12, limit: 1000, remaining: 988 },
        },
      }),
    );
    const client = new OpenRouterAccountClient({ fetch: fetchMock });
    expect(await client.freeUsage('sk-or-house')).toEqual({
      used: 12,
      limit: 1000,
      remaining: 988,
    });
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(String(url)).not.toContain('sk-or-house');
    expect(new Headers(init?.headers).get('authorization')).toBe(
      'Bearer sk-or-house',
    );
  });

  it('reports a refused key and an unknown free counter', async () => {
    const refused = new OpenRouterAccountClient({
      fetch: async () => json({}, 401),
    });
    await expect(refused.freeUsage('bad-key-1')).rejects.toBeInstanceOf(
      LlmKeyRejectedError,
    );
    const none = new OpenRouterAccountClient({
      fetch: async () => json({ data: {} }),
    });
    expect(await none.freeUsage('key-12345')).toBeNull();
  });

  it('exchanges an OAuth code with the verifier (S256)', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      json({ key: 'sk-or-v1-user' }),
    );
    const client = new OpenRouterAccountClient({ fetch: fetchMock });
    expect(await client.exchangeCode('the-code', 'the-verifier')).toBe(
      'sk-or-v1-user',
    );
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
      code: 'the-code',
      code_verifier: 'the-verifier',
      code_challenge_method: 'S256',
    });
    const failing = new OpenRouterAccountClient({
      fetch: async () => json({ error: 'x' }, 403),
    });
    await expect(failing.exchangeCode('c', 'v')).rejects.toThrow(/403/);
  });

  it('creates, limits and deletes a person’s key with the management key', async () => {
    const calls: { url: string; method: string; body: unknown }[] = [];
    const fetchMock = vi.fn<typeof fetch>(async (url, init) => {
      calls.push({
        url: String(url),
        method: init?.method ?? 'GET',
        body: init?.body ? JSON.parse(String(init.body)) : null,
      });
      if (init?.method === 'POST')
        return json({ key: 'sk-or-person', data: { hash: 'h1' } });
      if (init?.method === 'DELETE') return new Response(null, { status: 404 });
      return json({ data: {} });
    });
    const client = new OpenRouterAccountClient({ fetch: fetchMock });
    expect(
      await client.createKey('mgmt-key', {
        name: 'Nova Alexandria — a@b.c',
        limitUsd: 2,
      }),
    ).toEqual({ hash: 'h1', key: 'sk-or-person' });
    await client.updateKeyLimit('mgmt-key', { hash: 'h1', limitUsd: 3 });
    await client.deleteKey('mgmt-key', 'h1');
    expect(calls.map((c) => [c.method, c.url, c.body])).toEqual([
      [
        'POST',
        'https://openrouter.ai/api/v1/keys',
        { name: 'Nova Alexandria — a@b.c', limit: 2, limit_reset: 'monthly' },
      ],
      [
        'PATCH',
        'https://openrouter.ai/api/v1/keys/h1',
        { limit: 3, limit_reset: 'monthly' },
      ],
      ['DELETE', 'https://openrouter.ai/api/v1/keys/h1', null],
    ]);
    const broken = new OpenRouterAccountClient({
      fetch: async () => new Response(null, { status: 500 }),
    });
    await expect(broken.deleteKey('m', 'h')).rejects.toThrow(/500/);
  });
});
