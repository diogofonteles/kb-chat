import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { vaultGenerationModel } from '../llm-factory.js';
import { DisabledLlm } from './disabled-llm.js';
import { JsonlSpendLedger } from './jsonl-spend-ledger.js';
import { MemorySpendLedger } from './memory-spend-ledger.js';
import { OpenRouterAdapter, sseData } from './openrouter-adapter.js';

const sseBody = (lines: string[]): ReadableStream<Uint8Array> => {
  const bytes = new TextEncoder().encode(lines.join('\n'));
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes.slice(0, 20));
      controller.enqueue(bytes.slice(20));
      controller.close();
    },
  });
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status });

describe('sseData', () => {
  it('yields data payloads across chunk boundaries', async () => {
    const out: string[] = [];
    for await (const data of sseData(
      sseBody([': comment', 'data: {"a":1}', '', 'data: [DONE]', '']),
    ))
      out.push(data);
    expect(out).toEqual(['{"a":1}', '[DONE]']);
  });
});

describe('OpenRouterAdapter', () => {
  it('streams tokens and the real cost, with the key only in the header', async () => {
    const fetchMock = vi.fn<typeof fetch>(
      async () =>
        new Response(
          sseBody([
            'data: {"choices":[{"delta":{"content":"Olá "}}]}',
            'data: {"choices":[{"delta":{"content":"[1]"}}]}',
            'data: {"choices":[],"usage":{"prompt_tokens":100,"completion_tokens":5,"cost":0.0001}}',
            'data: [DONE]',
            '',
          ]),
        ),
    );
    const adapter = new OpenRouterAdapter({
      apiKey: 'sk-test',
      model: 'm',
      fetch: fetchMock,
    });
    const chunks = [];
    for await (const chunk of adapter.stream([{ role: 'user', content: 'q' }], {
      maxTokens: 10,
      signal: new AbortController().signal,
    }))
      chunks.push(chunk);
    expect(chunks).toEqual([
      { type: 'token', text: 'Olá ' },
      { type: 'token', text: '[1]' },
      {
        type: 'usage',
        usage: { inputTokens: 100, outputTokens: 5, usd: 0.0001 },
      },
    ]);
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect((init.headers as Record<string, string>).authorization).toBe(
      'Bearer sk-test',
    );
    expect(String(init.body)).not.toContain('sk-test');
    expect(JSON.parse(String(init.body))).toMatchObject({
      stream: true,
      reasoning: { enabled: false },
    });
    expect(JSON.parse(String(init.body))).toMatchObject({
      stream: true,
      reasoning: { enabled: false },
    });
    expect(adapter.configured()).toBe(true);
    expect(adapter.billing).toBe('per-token');
  });

  it('fails on an error status', async () => {
    const adapter = new OpenRouterAdapter({
      apiKey: 'k',
      model: 'm',
      fetch: vi.fn<typeof fetch>(async () => json({}, 402)),
    });
    const run = async () => {
      for await (const _ of adapter.stream([], {
        maxTokens: 1,
        signal: new AbortController().signal,
      }))
        void _;
    };
    await expect(run()).rejects.toThrow(/402/);
  });

  it('reads and caches the model price and the account balance', async () => {
    const fetchMock = vi.fn<typeof fetch>(async (url) =>
      String(url).endsWith('/models')
        ? json({
            data: [
              {
                id: 'm',
                pricing: { prompt: '0.000001', completion: '0.000002' },
              },
            ],
          })
        : json({ data: { total_credits: 20, total_usage: 10.5 } }),
    );
    const adapter = new OpenRouterAdapter({
      apiKey: 'k',
      model: 'm',
      fetch: fetchMock,
    });
    expect(await adapter.price()).toEqual({
      input: 0.000001,
      output: 0.000002,
    });
    expect(await adapter.balance()).toBe(9.5);
    await adapter.price();
    await adapter.balance();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('reports an unlisted model and an unreadable balance', async () => {
    const adapter = new OpenRouterAdapter({
      apiKey: undefined,
      model: 'x',
      fetch: vi.fn<typeof fetch>(async (url) =>
        String(url).endsWith('/models') ? json({ data: [] }) : json({}, 401),
      ),
    });
    expect(adapter.configured()).toBe(false);
    await expect(adapter.price()).rejects.toThrow(/not listed/);
    expect(await adapter.balance()).toBeNull();
  });
});

describe('spend ledgers', () => {
  it('sums today’s spend per principal from the JSONL file', async () => {
    const file = join(
      await mkdtemp(join(tmpdir(), 'kbchat-')),
      'state',
      'spend.jsonl',
    );
    const ledger = new JsonlSpendLedger(file);
    const now = new Date();
    const entry = {
      ts: now.toISOString(),
      principal: 'owner',
      model: 'm',
      inputTokens: 1,
      outputTokens: 1,
      usd: 0.25,
      interrupted: false,
    };
    await ledger.append(entry);
    await ledger.append({ ...entry, usd: 0.5 });
    await ledger.append({ ...entry, principal: 'guest' });
    await ledger.append({
      ...entry,
      ts: new Date(now.getTime() - 3 * 86_400_000).toISOString(),
    });
    expect(await ledger.spentToday('owner', now)).toBe(0.75);
    expect(
      await new JsonlSpendLedger(join(file, 'missing')).spentToday('owner'),
    ).toBe(0);
  });

  it('keeps the same rules in memory', async () => {
    const ledger = new MemorySpendLedger();
    await ledger.append({
      ts: new Date().toISOString(),
      principal: 'owner',
      model: 'm',
      inputTokens: 1,
      outputTokens: 1,
      usd: 0.1,
      interrupted: true,
    });
    expect(await ledger.spentToday('owner')).toBe(0.1);
  });
});

describe('vault generation model and the disabled provider', () => {
  it('reads [generation] model from kb.toml', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kbchat-'));
    await writeFile(
      join(dir, 'kb.toml'),
      '[vault]\nroot = "."\n\n[generation]\nmodel = "deepseek/x"\n',
    );
    expect(await vaultGenerationModel(dir)).toBe('deepseek/x');
    expect(await vaultGenerationModel(join(dir, 'none'))).toBeNull();
  });

  it('refuses everything when no provider is configured', async () => {
    const llm = new DisabledLlm();
    expect(llm.configured()).toBe(false);
    expect(await llm.price()).toEqual({ input: 0, output: 0 });
    expect(await llm.balance()).toBeNull();
    const run = async () => {
      for await (const _ of llm.stream()) void _;
    };
    await expect(run()).rejects.toThrow();
  });
});
