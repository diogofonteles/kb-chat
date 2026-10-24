import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { FIXTURE_VAULT } from '../../../test/fixture-paths.js';
import { FsVaultAdapter } from '../../adapters/fs-vault-adapter.js';
import { MemorySpendLedger } from '../../adapters/memory-spend-ledger.js';
import {
  StubLlmAdapter,
  type StubLlmOptions,
} from '../../adapters/stub-llm-adapter.js';
import { buildApp } from '../../app.js';
import { loadConfig } from '../../config.js';
import { createLogger } from '../../logger.js';
import { createSearchIndex } from '../../search-index-factory.js';

const LONG_ANSWER = Array.from({ length: 60 }, (_, i) => `palavra${i}`).join(
  ' ',
);
let app: FastifyInstance | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

async function start(
  llmOptions: StubLlmOptions = {},
  env: Record<string, string> = {},
) {
  const config = loadConfig({
    KB_VAULT: FIXTURE_VAULT,
    KB_CHAT_SEARCH: 'fixture',
    LOG_LEVEL: 'silent',
    ...env,
  });
  const vault = new FsVaultAdapter(config.KB_VAULT);
  const index = await createSearchIndex({
    config,
    vault,
    log: createLogger('silent'),
  });
  const llm = new StubLlmAdapter(llmOptions);
  const ledger = new MemorySpendLedger();
  app = await buildApp({
    config,
    vault,
    index,
    llm,
    ledger,
    logger: createLogger('silent'),
  });
  return { app, llm, ledger };
}

const post = (
  server: FastifyInstance,
  key: string,
  payload: object = { q: 'natureza' },
) =>
  server.inject({
    method: 'POST',
    url: '/api/v1/topics/hermetismo/answers',
    headers: { host: 'localhost', 'idempotency-key': key },
    payload,
  });

describe('answer spend guards (KBC-004 review)', () => {
  it('stops the model and records an interrupted spend when the client disconnects (AC-8)', async () => {
    const {
      app: server,
      llm,
      ledger,
    } = await start({ answer: LONG_ANSWER, tokenDelayMs: 20 });
    await server.listen({ host: '127.0.0.1', port: 0 });
    const address = server.server.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    const abort = new AbortController();
    const response = await fetch(
      `http://127.0.0.1:${port}/api/v1/topics/hermetismo/answers`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'idempotency-key': 'abort-key-1',
        },
        body: JSON.stringify({ q: 'natureza' }),
        signal: abort.signal,
      },
    );
    const reader = response.body?.getReader();
    await reader?.read();
    abort.abort();
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(llm.yielded).toBeLessThan(60);
    expect(ledger.entries).toHaveLength(1);
    expect(ledger.entries[0]?.interrupted).toBe(true);
  });

  it('refuses a key that is still streaming and a key reused for another question (FR-9)', async () => {
    const { app: server, llm } = await start({
      answer: LONG_ANSWER,
      tokenDelayMs: 5,
    });
    const first = post(server, 'busy-key-1');
    await new Promise((resolve) => setTimeout(resolve, 30));
    const second = await post(server, 'busy-key-1');
    expect(second.statusCode).toBe(409);
    expect(second.json().error.code).toBe('ANSWER_IN_PROGRESS');
    await first;
    const other = await post(server, 'busy-key-1', { q: 'outra pergunta' });
    expect(other.statusCode).toBe(400);
    expect(llm.calls).toBe(1);
  });

  it('replays without a new model call (AC-9)', async () => {
    const { app: server, llm } = await start();
    await post(server, 'replay-key-1');
    await post(server, 'replay-key-1');
    expect(llm.calls).toBe(1);
  });

  it('records the spend when the provider fails mid-stream and frees the key', async () => {
    const { app: server, llm, ledger } = await start();
    llm.stream = async function* () {
      yield { type: 'token' as const, text: 'Começo ' };
      throw new Error('provider down');
    };
    await post(server, 'fail-key-1');
    expect(ledger.entries).toHaveLength(1);
    expect(ledger.entries[0]?.interrupted).toBe(true);
    expect((await post(server, 'fail-key-1')).statusCode).toBe(200);
  });

  it('prices an answer from the price list when the provider reports no cost', async () => {
    const { app: server, llm, ledger } = await start();
    llm.stream = async function* () {
      yield { type: 'token' as const, text: 'Resposta [1].' };
      yield {
        type: 'usage' as const,
        usage: { inputTokens: 1000, outputTokens: 100, usd: null },
      };
    };
    await post(server, 'cost-key-1');
    expect(ledger.entries[0]?.usd).toBeCloseTo(1100e-6, 9);
  });

  it('never returns the provider key in any response (AC-10)', async () => {
    const { app: server } = await start(
      {},
      { OPENROUTER_API_KEY: 'sk-or-secret-value-123' },
    );
    const headers = { host: 'localhost' };
    const bodies = await Promise.all([
      server.inject({ method: 'GET', url: '/health', headers }),
      server.inject({ method: 'GET', url: '/api/v1/topics', headers }),
      server.inject({ method: 'GET', url: '/api/v1/spend/today', headers }),
      server.inject({
        method: 'POST',
        url: '/api/v1/topics/hermetismo/answers/estimates',
        headers,
        payload: { q: 'x y z' },
      }),
      post(server, 'secret-key-1'),
    ]);
    for (const response of bodies)
      expect(response.body).not.toContain('sk-or-secret-value-123');
  });
});
