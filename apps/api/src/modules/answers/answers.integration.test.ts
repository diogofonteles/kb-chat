import type { AnswerEvent } from '@kb-chat/contracts';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { FIXTURE_VAULT } from '../../../test/fixture-paths.js';
import { FsVaultAdapter } from '../../adapters/fs-vault-adapter.js';
import { MemorySpendLedger } from '../../adapters/memory-spend-ledger.js';
import {
  StubLlmAdapter,
  type StubLlmOptions,
} from '../../adapters/stub-llm-adapter.js';
import { OWNER, buildApp } from '../../app.js';
import { loadConfig } from '../../config.js';
import { createLogger } from '../../logger.js';
import { createSearchIndex } from '../../search-index-factory.js';

const HOST = { host: 'localhost' };
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

const ask = (server: FastifyInstance, payload: object, key = 'key-12345678') =>
  server.inject({
    method: 'POST',
    url: '/api/v1/topics/hermetismo/answers',
    headers: { ...HOST, 'idempotency-key': key },
    payload,
  });

const events = (body: string): AnswerEvent[] =>
  body
    .split('\n\n')
    .filter((block) => block.startsWith('data: '))
    .map((block) => JSON.parse(block.slice(6)) as AnswerEvent);

describe('POST /api/v1/topics/:topic/answers', () => {
  it('streams sources, tokens and the cost, and records the spend (AC-3, BR-6)', async () => {
    const { app: server, ledger, llm } = await start();
    const response = await ask(server, {
      q: 'natureza sétupla',
      mode: 'semantic',
    });
    expect(response.headers['content-type']).toMatch(/text\/event-stream/);
    const stream = events(response.body);
    expect(stream[0]).toMatchObject({ type: 'sources' });
    expect(
      stream
        .filter((e) => e.type === 'token')
        .map((e) => (e.type === 'token' ? e.text : ''))
        .join(''),
    ).toBe('Segundo o acervo, a natureza é sétupla [1].');
    expect(stream.at(-1)).toMatchObject({
      type: 'done',
      model: 'stub/model',
      interrupted: false,
    });
    expect(ledger.entries).toHaveLength(1);
    expect(ledger.entries[0]).toMatchObject({
      principal: OWNER,
      interrupted: false,
    });
    expect(llm.lastMessages[1]?.content).toContain('[1] A Natureza Sétupla');
  });

  it('sends at most 8 passages of a summary plus at most 2,500 characters (AC-4)', async () => {
    const { app: server, llm } = await start();
    const response = await ask(server, { q: 'ritmo', mode: 'semantic' });
    const sources = events(response.body)[0];
    expect(sources?.type === 'sources' && sources.sources.length).toBe(8);
    const quoted =
      llm.lastMessages[1]?.content.split('"""').filter((_, i) => i % 2 === 1) ??
      [];
    expect(quoted).toHaveLength(8);
    expect(
      Math.max(...quoted.map((text) => text.trim().length)),
    ).toBeLessThanOrEqual(2700);
  });

  it('replays the same answer for a repeated Idempotency-Key without spending again (AC-9)', async () => {
    const { app: server, ledger } = await start();
    const first = await ask(server, { q: 'natureza' }, 'same-key-123');
    const second = await ask(server, { q: 'natureza' }, 'same-key-123');
    expect(second.body).toBe(first.body);
    expect(ledger.entries).toHaveLength(1);
  });

  it('refuses over the daily cap before streaming (AC-5)', async () => {
    const { app: server, ledger } = await start(
      {},
      { KB_CHAT_DAILY_CAP_USD: '0.001' },
    );
    await ledger.append({
      ts: new Date().toISOString(),
      principal: OWNER,
      model: 'm',
      inputTokens: 0,
      outputTokens: 0,
      usd: 0.001,
      interrupted: false,
    });
    const response = await ask(server, { q: 'natureza' });
    expect(response.statusCode).toBe(429);
    expect(response.json().error.code).toBe('DAILY_CAP_REACHED');
  });

  it('refuses when the account has no credit (AC-7) or no provider (AC-6)', async () => {
    const broke = await start({ balance: 0 });
    expect((await ask(broke.app, { q: 'natureza' })).json().error.code).toBe(
      'LLM_INSUFFICIENT_CREDIT',
    );
    await broke.app.close();
    const none = await start({ configured: false });
    const response = await ask(none.app, { q: 'natureza' });
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe('LLM_NOT_CONFIGURED');
  });

  it('requires an Idempotency-Key', async () => {
    const { app: server } = await start();
    const response = await server.inject({
      method: 'POST',
      url: '/api/v1/topics/hermetismo/answers',
      headers: HOST,
      payload: { q: 'natureza' },
    });
    expect(response.statusCode).toBe(400);
  });

  it('reports a provider failure inside the stream', async () => {
    const { app: server, llm } = await start();
    llm.stream = async function* () {
      yield { type: 'token' as const, text: 'Começo ' };
      throw new Error('provider down');
    };
    const stream = events((await ask(server, { q: 'natureza' })).body);
    expect(stream.at(-1)).toEqual({ type: 'error', code: 'INTERNAL' });
  });
});

describe('estimates and spend', () => {
  it('estimates the cost from the passages and the price', async () => {
    const { app: server } = await start();
    const response = await server.inject({
      method: 'POST',
      url: '/api/v1/topics/hermetismo/answers/estimates',
      headers: HOST,
      payload: { q: 'natureza' },
    });
    expect(response.json()).toMatchObject({
      model: 'stub/model',
      passages: 3,
      billing: 'per-token',
    });
    expect(response.json().usd).toBeGreaterThan(0.0008);
  });

  it('reports today’s spend, the cap and whether AI is configured (AC-8 data)', async () => {
    const { app: server } = await start({ configured: false });
    const response = await server.inject({
      method: 'GET',
      url: '/api/v1/spend/today',
      headers: HOST,
    });
    expect(response.json()).toEqual({ usd: 0, capUsd: 1, configured: false });
  });
});
