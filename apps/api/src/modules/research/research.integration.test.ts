import type { ResearchEvent } from '@kb-chat/contracts';
import { researchEventSchema } from '@kb-chat/contracts';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { FIXTURE_VAULT } from '../../../test/fixture-paths.js';
import { answerText } from '../../../test/research-factories.js';
import { FsVaultAdapter } from '../../adapters/fs-vault-adapter.js';
import { MemorySpendLedger } from '../../adapters/memory-spend-ledger.js';
import {
  StubLlmAdapter,
  type StubLlmOptions,
} from '../../adapters/stub-llm-adapter.js';
import { OpenRouterAdapter } from '../../adapters/openrouter-adapter.js';
import { OWNER, buildApp } from '../../app.js';
import type { AgentLlmPort } from '../../ports/llm.js';
import { loadConfig } from '../../config.js';
import { createLogger } from '../../logger.js';
import { createSearchIndex } from '../../search-index-factory.js';

const HOST = { host: 'localhost' };
let app: FastifyInstance | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

async function start(llmOptions: StubLlmOptions = {}, model?: AgentLlmPort) {
  const config = loadConfig({
    KB_VAULT: FIXTURE_VAULT,
    KB_CHAT_SEARCH: 'fixture',
    LOG_LEVEL: 'silent',
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
    llm: model ?? llm,
    ledger,
    logger: createLogger('silent'),
  });
  return { app, llm, ledger };
}

const ask = (server: FastifyInstance, payload: object, topic = 'hermetismo') =>
  server.inject({
    method: 'POST',
    url: `/api/v1/topics/${topic}/research`,
    headers: HOST,
    payload,
  });

const events = (body: string): ResearchEvent[] =>
  body
    .split('\n\n')
    .filter((block) => block.startsWith('data: '))
    .map((block) => researchEventSchema.parse(JSON.parse(block.slice(6))));

/** OpenRouter over HTTP that lists the model and refuses the key on every completion. */
const refusingOpenRouter = (): AgentLlmPort =>
  new OpenRouterAdapter({
    apiKey: 'sk-or-refused-1234',
    model: 'm/refused',
    fetch: async (url) => {
      if (String(url).endsWith('/models'))
        return Response.json({
          data: [
            { id: 'm/refused', pricing: { prompt: '0', completion: '0' } },
          ],
        });
      if (String(url).endsWith('/credits'))
        return Response.json({}, { status: 401 });
      return new Response('{"error":"bad key"}', { status: 401 });
    },
  });

describe('POST /api/v1/topics/:topic/research', () => {
  it('streams LLM_KEY_REJECTED when OpenRouter refuses the key (KBC-007)', async () => {
    const { app: server } = await start({}, refusingOpenRouter());
    const stream = events((await ask(server, { question: 'ritmo' })).body);
    expect(stream.at(-1)).toEqual({ type: 'error', code: 'LLM_KEY_REJECTED' });
  });

  it('streams steps, sources, the answer and the cost, and records one spend entry (AC-1)', async () => {
    const { app: server, ledger } = await start();
    const response = await ask(server, { question: 'ritmo' });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toMatch(/text\/event-stream/);
    const stream = events(response.body);
    expect(stream.map((e) => e.type)).toEqual([
      'start',
      'step',
      'step',
      'sources',
      'step',
      'token',
      'done',
    ]);
    const sources = stream.find((e) => e.type === 'sources');
    const cited = [...answerText(stream).matchAll(/\[(\d+)\]/g)].map((m) =>
      Number(m[1]),
    );
    expect(cited.length).toBeGreaterThan(0);
    for (const n of cited)
      expect(
        sources?.type === 'sources' && sources.sources.some((s) => s.n === n),
      ).toBe(true);
    expect(stream.at(-1)).toMatchObject({
      type: 'done',
      model: 'stub/model',
      interrupted: false,
      steps: 3,
    });
    expect(ledger.entries).toHaveLength(1);
    expect(ledger.entries[0]).toMatchObject({
      principal: OWNER,
      model: 'stub/model',
      interrupted: false,
    });
  });

  it('accepts the conversation so far and sends it to the model (AC-2 data)', async () => {
    const { app: server, llm } = await start();
    const history = [
      { question: 'o que é o ritmo?', answer: 'É uma lei [1].' },
    ];
    await ask(server, { question: 'e a polaridade?', history });
    expect(llm.lastMessages.slice(1, 4).map((m) => m.content)).toEqual([
      'o que é o ritmo?',
      'É uma lei [1].',
      'e a polaridade?',
    ]);
  });

  it('streams DAILY_CAP_REACHED when the cap is hit mid-way (AC-4)', async () => {
    const { app: server } = await start({ usdPerCall: 0.6 });
    const stream = events((await ask(server, { question: 'ritmo' })).body);
    expect(stream.at(-1)).toEqual({ type: 'error', code: 'DAILY_CAP_REACHED' });
    const spend = await server.inject({
      method: 'GET',
      url: '/api/v1/spend/today',
      headers: HOST,
    });
    expect(spend.json()).toEqual({ usd: 1.2, capUsd: 1, configured: true });
  });

  it('refuses without a provider (409), for an unknown topic (404) and an invalid body (400)', async () => {
    const none = await start({ configured: false });
    const refused = await ask(none.app, { question: 'ritmo' });
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error.code).toBe('LLM_NOT_CONFIGURED');
    const spend = await none.app.inject({
      method: 'GET',
      url: '/api/v1/spend/today',
      headers: HOST,
    });
    expect(spend.json()).toEqual({ usd: 0, capUsd: 1, configured: false });
    await none.app.close();
    const { app: server } = await start();
    expect(
      (await ask(server, { question: 'ritmo' }, 'nope')).json().error.code,
    ).toBe('TOPIC_NOT_FOUND');
    expect((await ask(server, { question: '' })).statusCode).toBe(400);
    expect((await ask(server, { question: 'x', extra: 1 })).statusCode).toBe(
      400,
    );
  });

  it('reports a provider failure inside the stream', async () => {
    const { app: server, llm } = await start();
    llm.streamAgent = async function* () {
      yield* [];
      throw new Error('provider down');
    };
    const stream = events((await ask(server, { question: 'ritmo' })).body);
    expect(stream).toEqual([
      { type: 'start', model: 'stub/model', billing: 'per-token' },
      { type: 'error', code: 'INTERNAL' },
    ]);
  });

  it('no longer serves the single-call answers route', async () => {
    const { app: server } = await start();
    const response = await server.inject({
      method: 'POST',
      url: '/api/v1/topics/hermetismo/answers',
      headers: HOST,
      payload: { q: 'ritmo' },
    });
    expect(response.statusCode).toBe(404);
  });
});
