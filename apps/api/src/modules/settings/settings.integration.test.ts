import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import type { FastifyInstance } from 'fastify';
import pino from 'pino';
import { afterEach, describe, expect, it } from 'vitest';
import { FAKES_DIR, FIXTURE_VAULT } from '../../../test/fixture-paths.js';
import { researchEventSchema, type ResearchEvent } from '@kb-chat/contracts';
import { FsVaultAdapter } from '../../adapters/fs-vault-adapter.js';
import { JsonSettingsStore } from '../../adapters/json-settings-store.js';
import { MemorySpendLedger } from '../../adapters/memory-spend-ledger.js';
import { OWNER, buildApp } from '../../app.js';
import { loadConfig } from '../../config.js';
import { createAiProviders } from '../../providers/create-ai-providers.js';
import { createResearchAgent } from '../../research-agent-factory.js';
import { createSearchIndex } from '../../search-index-factory.js';
import { CatalogRegistry } from '../catalog/index.js';
import { freePort } from '../../../test/free-port.js';

const HOST = { host: 'localhost:3000' };
const KEY = 'sk-or-v1-secret-key-abcd';

interface TestApp {
  readonly app: FastifyInstance;
  readonly state: string;
  readonly logs: string[];
  readonly port: number;
  readonly ledger: MemorySpendLedger;
}

let current: FastifyInstance | null = null;

afterEach(async () => {
  await current?.close();
  current = null;
});

/** Providers answer 401 unless the key ends in "valid" (no paid API is ever called). */
const fakeFetch: typeof fetch = async (_url, init) => {
  const headers = new Headers(init?.headers);
  const key =
    headers.get('x-api-key') ??
    headers.get('authorization')?.replace(/^Bearer /, '');
  if (!key?.endsWith('valid')) return new Response('{}', { status: 401 });
  return new Response('data: {"choices":[{"delta":{"content":"ok"}}]}\n\n');
};

async function start(
  env: Record<string, string> = {},
  pathEnv = '',
): Promise<TestApp> {
  const state = await mkdtemp(join(tmpdir(), 'kbchat-settings-'));
  const config = loadConfig({
    KB_VAULT: FIXTURE_VAULT,
    KB_CHAT_SEARCH: 'fixture',
    KB_CHAT_STATE_DIR: state,
    LOG_LEVEL: 'info',
    PORT: String(await freePort()),
    ...env,
  });
  const vault = new FsVaultAdapter(config.KB_VAULT);
  const logs: string[] = [];
  const sink = new Writable({
    write(chunk, _encoding, done) {
      logs.push(String(chunk));
      done();
    },
  });
  const index = await createSearchIndex({
    config,
    vault,
    log: { warn: () => undefined },
  });
  const ledger = new MemorySpendLedger();
  const catalog = new CatalogRegistry(vault);
  await catalog.load();
  // Bound like main: the same research tools for the in-API loop and the CLIs.
  const agent = createResearchAgent({ catalog, index, vault, ledger });
  const ai = await createAiProviders({
    config,
    principal: OWNER,
    store: new JsonSettingsStore(join(state, 'settings')),
    env: { PATH: pathEnv },
    fetch: fakeFetch,
    tools: agent.toolsFor,
    perTokenRunner: agent.perTokenRunner,
    systemPrompt: agent.systemPrompt,
  });
  const app = await buildApp({
    config,
    vault,
    index,
    catalog,
    agent,
    ai,
    ledger,
    logger: pino({ level: 'info' }, sink),
  });
  current = app;
  return { app, state, logs, port: config.PORT, ledger };
}

const put = (app: FastifyInstance, payload: object) =>
  app.inject({
    method: 'PUT',
    url: '/api/v1/settings',
    headers: HOST,
    payload,
  });
const get = (app: FastifyInstance, url: string) =>
  app.inject({ method: 'GET', url, headers: HOST });

describe('GET/PUT /api/v1/settings', () => {
  it('reports no settings before the first save, then remembers them (BR-5)', async () => {
    const { app } = await start();
    expect((await get(app, '/api/v1/settings')).json()).toMatchObject({
      exists: false,
      preferences: {
        searchMode: 'all',
        theme: 'auto',
        defaultView: 'research',
      },
      ai: { provider: null, keys: {}, dailyCapUsd: 1 },
    });
    const saved = await put(app, {
      preferences: { theme: 'dark', defaultTopic: 'alquimia' },
    });
    expect(saved.statusCode).toBe(200);
    expect(saved.json()).toMatchObject({
      exists: true,
      preferences: { theme: 'dark', defaultTopic: 'alquimia' },
    });
  });

  it('returns only the last 4 characters of a saved key, in a 0600 file (AC-2, NFR-2)', async () => {
    const { app, state, logs } = await start();
    await put(app, {
      ai: { provider: 'openrouter', keys: { openrouter: KEY } },
    });
    const response = await get(app, '/api/v1/settings');
    expect(response.json().ai.keys).toEqual({
      openrouter: { set: true, last4: 'abcd' },
    });
    expect(response.body).not.toContain(KEY);
    const file = join(state, 'settings', 'owner.json');
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect((await stat(join(state, 'settings'))).mode & 0o777).toBe(0o700);
    expect(await readFile(file, 'utf8')).toContain(KEY);
    expect(logs.join('')).not.toContain(KEY);
  });

  it('removes a key with null and keeps the other settings', async () => {
    const { app } = await start();
    await put(app, {
      ai: { keys: { openai: 'sk-openai-1234' }, dailyCapUsd: 2 },
    });
    const response = await put(app, { ai: { keys: { openai: null } } });
    expect(response.json().ai).toMatchObject({ keys: {}, dailyCapUsd: 2 });
  });

  it('refuses unknown fields and invalid values with 400', async () => {
    const { app } = await start();
    expect((await put(app, { ai: { provider: 'gemini' } })).statusCode).toBe(
      400,
    );
    expect((await put(app, { extra: true })).statusCode).toBe(400);
    expect((await put(app, { ai: { dailyCapUsd: 1000 } })).statusCode).toBe(
      400,
    );
  });

  it('serves the saved default collection as the topics default', async () => {
    const { app } = await start();
    await put(app, { preferences: { defaultTopic: 'alquimia' } });
    expect((await get(app, '/api/v1/topics')).json().defaultSlug).toBe(
      'alquimia',
    );
  });
});

describe('GET /api/v1/ai/providers', () => {
  it('shows the Claude subscription disabled when claude is not on PATH (AC-3)', async () => {
    const { app } = await start();
    const items = (await get(app, '/api/v1/ai/providers')).json().items;
    expect(
      items.find((p: { id: string }) => p.id === 'claude-subscription'),
    ).toMatchObject({
      billing: 'subscription',
      available: false,
      reason: 'cli-missing',
    });
  });

  it('finds claude on PATH and the OpenRouter key in the environment (BR-3, BR-4)', async () => {
    const { app } = await start(
      {
        OPENROUTER_API_KEY: KEY,
        CLAUDE_BIN: join(FAKES_DIR, 'fake-claude.mjs'),
      },
      '',
    );
    const list = (await get(app, '/api/v1/ai/providers')).json();
    const byId = new Map(list.items.map((p: { id: string }) => [p.id, p]));
    expect(byId.get('claude-subscription')).toMatchObject({
      available: true,
      reason: null,
    });
    expect(byId.get('openrouter')).toMatchObject({
      available: true,
      keySource: 'env',
    });
    expect(byId.get('anthropic')).toMatchObject({
      available: false,
      reason: 'key-missing',
      defaultModel: 'claude-opus-5-5',
    });
    // claude on PATH comes before the env keys (BR-4, owner's decision 2026-10-24).
    expect(list.active).toBe('claude-subscription');
  });

  it('switches the active provider on the next request, without a restart (FR-5)', async () => {
    const { app } = await start({ OPENROUTER_API_KEY: KEY });
    await put(app, {
      ai: { provider: 'anthropic', keys: { anthropic: 'sk-ant-x-1234' } },
    });
    expect((await get(app, '/api/v1/ai/providers')).json().active).toBe(
      'anthropic',
    );
    expect((await get(app, '/api/v1/spend/today')).json().configured).toBe(
      true,
    );
    await put(app, { ai: { provider: 'none' } });
    expect((await get(app, '/api/v1/spend/today')).json().configured).toBe(
      false,
    );
  });
});

describe('POST /api/v1/settings/ai/test', () => {
  const test = (app: FastifyInstance, payload: object) =>
    app.inject({
      method: 'POST',
      url: '/api/v1/settings/ai/test',
      headers: HOST,
      payload,
    });

  it('reports LLM_KEY_REJECTED for a key the provider refuses (AC-5)', async () => {
    const { app, logs } = await start();
    const response = await test(app, {
      provider: 'openrouter',
      key: 'sk-or-wrong-9876',
    });
    expect(response.json()).toMatchObject({
      ok: false,
      code: 'LLM_KEY_REJECTED',
    });
    expect(response.body).not.toContain('sk-or-wrong-9876');
    expect(logs.join('')).not.toContain('sk-or-wrong-9876');
  });

  it('accepts a working key for each per-token provider', async () => {
    const { app } = await start();
    for (const provider of ['openrouter', 'openai'])
      expect(
        (await test(app, { provider, key: 'sk-test-valid' })).json(),
      ).toMatchObject({ ok: true, code: null });
  });

  it('reports a missing key and a missing CLI', async () => {
    const { app } = await start();
    expect((await test(app, { provider: 'openai' })).json().code).toBe(
      'LLM_NOT_CONFIGURED',
    );
    expect(
      (await test(app, { provider: 'claude-subscription' })).json().code,
    ).toBe('CLI_MISSING');
  });

  it('tests the Claude subscription through the CLI, login included', async () => {
    const { app, port } = await start(
      { CLAUDE_BIN: join(FAKES_DIR, 'fake-claude.mjs') },
      process.env.PATH ?? '',
    );
    // The CLI reaches the turn's MCP endpoint over HTTP, so this app really listens.
    await app.listen({ host: '127.0.0.1', port });
    const response = await test(app, { provider: 'claude-subscription' });
    expect(response.json()).toMatchObject({
      ok: true,
      model: 'claude-subscription',
    });
  });
});

describe('POST /api/v1/topics/:topic/research with the provider in Settings', () => {
  const research = (app: FastifyInstance) =>
    app.inject({
      method: 'POST',
      url: '/api/v1/topics/hermetismo/research',
      headers: HOST,
      payload: { question: 'O que é o ritmo?' },
    });
  const events = (body: string): ResearchEvent[] =>
    body
      .split('\n\n')
      .filter((block) => block.startsWith('data: '))
      .map((block) => researchEventSchema.parse(JSON.parse(block.slice(6))));

  it('runs the turn on the Claude subscription over the real tools, outside the ledger (AC-4)', async () => {
    const { app, port, ledger } = await start(
      { CLAUDE_BIN: join(FAKES_DIR, 'fake-claude.mjs') },
      process.env.PATH ?? '',
    );
    await app.listen({ host: '127.0.0.1', port });
    await put(app, { ai: { provider: 'claude-subscription' } });
    const stream = events((await research(app)).body);
    expect(stream.find((e) => e.type === 'step')).toEqual({
      type: 'step',
      step: { kind: 'search', text: 'Buscando “ritmo”' },
    });
    const sources = stream.find((e) => e.type === 'sources');
    expect(sources?.type === 'sources' && sources.sources[0]?.n).toBe(1);
    expect(stream.at(-1)).toMatchObject({
      type: 'done',
      usd: 0,
      billing: 'subscription',
      steps: 1,
    });
    expect(ledger.entries).toEqual([]);
    expect((await get(app, '/api/v1/spend/today')).json()).toMatchObject({
      usd: 0,
      configured: true,
    });
  });

  it("checks a per-token turn against the principal's daily cap in Settings", async () => {
    const { app, ledger } = await start({ KB_CHAT_LLM: 'stub' });
    await put(app, { ai: { dailyCapUsd: 0 } });
    expect(events((await research(app)).body)).toEqual([
      { type: 'start', model: 'stub/model', billing: 'per-token' },
      { type: 'error', code: 'DAILY_CAP_REACHED' },
    ]);
    await put(app, { ai: { dailyCapUsd: 1 } });
    const done = events((await research(app)).body).at(-1);
    expect(done).toMatchObject({ type: 'done', billing: 'per-token' });
    expect(ledger.entries).toHaveLength(1);
  });
});
