import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import type {
  FastifyInstance,
  InjectOptions,
  LightMyRequestResponse,
} from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CSRF_HEADER,
  CSRF_HEADER_VALUE,
  researchEventSchema,
  type ResearchEvent,
} from '@kb-chat/contracts';
import pino from 'pino';
import { FIXTURE_VAULT } from '../test/fixture-paths.js';
import {
  TEST_CLIENT_ID,
  createTestKeys,
  mintIdToken,
  testVerifier,
  type TestKeys,
} from '../test/identity-factories.js';
import { FsSessionStore } from './adapters/fs-session-store.js';
import { FsVaultAdapter } from './adapters/fs-vault-adapter.js';
import { JsonPeopleStore } from './adapters/json-people-store.js';
import { JsonSettingsStore } from './adapters/json-settings-store.js';
import { JsonlSpendLedger } from './adapters/jsonl-spend-ledger.js';
import { SealedSettingsStore } from './adapters/sealed-settings-store.js';
import { SecretBox } from './adapters/secret-box.js';
import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { createHouseAi } from './house-ai-factory.js';
import { PeopleService, SessionService } from './modules/auth/index.js';
import { CatalogRegistry } from './modules/catalog/index.js';
import { createAiProviders } from './providers/create-ai-providers.js';
import { createResearchAgent } from './research-agent-factory.js';
import { createSearchIndex } from './search-index-factory.js';
import { FakeOpenRouter } from './testing/fake-openrouter.js';

const OWNER_EMAIL = 'owner@example.com';
const WEB = 'http://localhost:4200';
const LOCAL = { host: 'localhost:3000', [CSRF_HEADER]: CSRF_HEADER_VALUE };

interface Started {
  readonly app: FastifyInstance;
  readonly keys: TestKeys;
  readonly state: string;
  readonly fake: FakeOpenRouter;
  readonly logs: string[];
}

let current: FastifyInstance | null = null;
afterEach(async () => {
  await current?.close();
  current = null;
});

/** The app as main builds it, with sealed settings and the house over a fake OpenRouter. */
async function start(): Promise<Started> {
  const state = await mkdtemp(join(tmpdir(), 'kbchat-house-'));
  const config = loadConfig({
    KB_VAULT: FIXTURE_VAULT,
    KB_CHAT_SEARCH: 'fixture',
    KB_CHAT_STATE_DIR: state,
    GOOGLE_CLIENT_ID: TEST_CLIENT_ID,
    KB_CHAT_OWNER_EMAIL: OWNER_EMAIL,
    WEB_ORIGIN: WEB,
    LOG_LEVEL: 'info',
  });
  const logs: string[] = [];
  const logger = pino(
    { level: 'info' },
    new Writable({
      write(chunk, _encoding, done) {
        logs.push(String(chunk));
        done();
      },
    }),
  );
  const fake = new FakeOpenRouter();
  const keys = await createTestKeys();
  const sealer = new SecretBox(randomBytes(32));
  const vault = new FsVaultAdapter(config.KB_VAULT);
  const index = await createSearchIndex({ config, vault, log: logger });
  const catalog = new CatalogRegistry(vault);
  await catalog.load();
  const ledger = new JsonlSpendLedger(join(state, 'spend.jsonl'));
  const agent = createResearchAgent({ catalog, index, vault, ledger });
  const auth = {
    people: new PeopleService({
      store: new JsonPeopleStore(join(state, 'people.json')),
      ownerEmail: OWNER_EMAIL,
    }),
    sessions: new SessionService({
      store: new FsSessionStore(join(state, 'sessions')),
    }),
    verifier: testVerifier(keys),
  };
  const house = await createHouseAi({
    stateDir: state,
    sealer,
    webOrigin: WEB,
    fetch: fake.fetch,
  });
  const ai = await createAiProviders({
    config,
    principal: 'owner',
    store: new SealedSettingsStore({
      store: new JsonSettingsStore(join(state, 'settings')),
      sealer,
    }),
    env: { PATH: '' },
    fetch: fake.fetch,
    tools: agent.toolsFor,
    perTokenRunner: agent.perTokenRunner,
    systemPrompt: agent.systemPrompt,
    house,
    personOf: (principal) => auth.people.cachedByPrincipal(principal),
  });
  const app = await buildApp({
    config,
    vault,
    index,
    catalog,
    agent,
    ai,
    ledger,
    auth,
    house,
    logger,
  });
  current = app;
  return { app, keys, state, fake, logs };
}

const cookieOf = (setCookie: unknown): string =>
  String(Array.isArray(setCookie) ? setCookie[0] : setCookie).split(';')[0] ??
  '';

async function signIn(
  { app, keys }: Started,
  email: string,
): Promise<Record<string, string>> {
  const credential = await mintIdToken(keys, { email, sub: `sub-${email}` });
  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/google',
    headers: LOCAL,
    payload: { credential },
  });
  expect(response.statusCode).toBe(200);
  return { ...LOCAL, cookie: cookieOf(response.headers['set-cookie']) };
}

type Call = (
  method: InjectOptions['method'],
  url: string,
  payload?: object,
) => Promise<LightMyRequestResponse>;

const caller =
  (app: FastifyInstance, headers: Record<string, string>): Call =>
  (method, url, payload) =>
    app.inject({ method, url, headers, ...(payload && { payload }) });

/** The owner (master) and an invited member with research on the fixture collection. */
async function withPeople(started: Started) {
  const owner = caller(started.app, await signIn(started, OWNER_EMAIL));
  const invited = await owner('POST', '/api/v1/people', {
    email: 'ana@example.com',
  });
  const id: string = invited.json().id;
  await owner('PATCH', `/api/v1/people/${id}`, {
    topics: ['hermetismo'],
    features: ['search', 'research', 'own-ai-settings'],
  });
  const member = caller(started.app, await signIn(started, 'ana@example.com'));
  return { owner, member, memberId: id };
}

/** Connects the house account through the OAuth PKCE flow against the fake. */
async function connectHouse(started: Started, owner: Call) {
  const { authorizeUrl } = (
    await owner('POST', '/api/v1/openrouter/connect', { purpose: 'house' })
  ).json();
  const url = new URL(authorizeUrl);
  const challenge = url.searchParams.get('code_challenge') ?? '';
  const state = url.searchParams.get('state') ?? '';
  const code = started.fake.authorize(challenge, 'sk-or-v1-house-oauth-wxyz');
  const back = await owner(
    'GET',
    `/api/v1/openrouter/callback?code=${code}&state=${state}`,
  );
  return { back, state, code };
}

const events = (body: string): ResearchEvent[] =>
  body
    .split('\n\n')
    .filter((block) => block.startsWith('data: '))
    .map((block) => researchEventSchema.parse(JSON.parse(block.slice(6))));

const research = async (call: Call, profile = 'fast') =>
  events(
    (
      await call('POST', '/api/v1/topics/hermetismo/research', {
        question: 'O que é o mentalismo?',
        profile,
      })
    ).body,
  );

const statePlain = async (state: string): Promise<string> => {
  const settings = await readdir(join(state, 'settings')).catch(() => []);
  const files = [
    ...settings.map((name) => join(state, 'settings', name)),
    join(state, 'house-ai.json'),
  ];
  const texts = await Promise.all(
    files.map((file) => readFile(file, 'utf8').catch(() => '')),
  );
  return texts.join('\n');
};

describe('IA da aplicação: connection (KBC-022 AC-1, AC-2)', () => {
  it('connects the house account with OAuth PKCE and keeps only a sealed key', async () => {
    const started = await start();
    const { owner } = await withPeople(started);
    const { back, state, code } = await connectHouse(started, owner);
    expect(back.statusCode).toBe(303);
    expect(back.headers.location).toBe('/?openrouter=connected&for=house');
    const view = (await owner('GET', '/api/v1/house-ai')).json();
    expect(view.connection).toMatchObject({
      key: { set: true, last4: 'wxyz' },
      via: 'oauth',
      connectedBy: OWNER_EMAIL,
    });
    expect(view.chain).toEqual([
      'fake/large:free',
      'fake/small:free',
      'openrouter/free',
    ]);
    expect(view.freeUsage).toEqual({ used: 0, limit: 1000, remaining: 1000 });
    expect(await statePlain(started.state)).not.toContain('house-oauth');
    expect(started.logs.join('\n')).not.toContain(code);
    // The same state again, a made-up one, or no code: nothing is stored.
    const replay = await owner(
      'GET',
      `/api/v1/openrouter/callback?code=${code}&state=${state}`,
    );
    expect(replay.headers.location).toBe('/?openrouter=error');
    const missing = await owner('GET', '/api/v1/openrouter/callback?state=x');
    expect(missing.headers.location).toBe('/?openrouter=error');
  });

  it('refuses a callback from another session and anything house-related to a member', async () => {
    const started = await start();
    const { owner, member } = await withPeople(started);
    const { authorizeUrl } = (
      await owner('POST', '/api/v1/openrouter/connect', { purpose: 'house' })
    ).json();
    const state = new URL(authorizeUrl).searchParams.get('state') ?? '';
    const stolen = await member(
      'GET',
      `/api/v1/openrouter/callback?code=abc&state=${state}`,
    );
    expect(stolen.headers.location).toBe('/?openrouter=error');
    expect((await member('GET', '/api/v1/house-ai')).statusCode).toBe(403);
    expect(
      (await member('PUT', '/api/v1/house-ai', { includeRouter: false }))
        .statusCode,
    ).toBe(403);
    expect(
      (await member('POST', '/api/v1/openrouter/connect', { purpose: 'house' }))
        .statusCode,
    ).toBe(403);
    expect((await member('GET', '/api/v1/ai/free-models')).statusCode).toBe(
      200,
    );
  });

  it('accepts a pasted key, tests it, and disconnects', async () => {
    const started = await start();
    const { owner } = await withPeople(started);
    started.fake.acceptKey('sk-or-v1-pasted-1234');
    const view = (
      await owner('PUT', '/api/v1/house-ai', { key: 'sk-or-v1-pasted-1234' })
    ).json();
    expect(view.connection).toMatchObject({
      via: 'key',
      key: { last4: '1234' },
    });
    expect((await owner('POST', '/api/v1/house-ai/test')).json()).toMatchObject(
      {
        ok: true,
      },
    );
    expect((await owner('DELETE', '/api/v1/house-ai/key')).statusCode).toBe(
      204,
    );
    expect((await owner('POST', '/api/v1/house-ai/test')).json()).toMatchObject(
      {
        ok: false,
        code: 'LLM_NOT_CONFIGURED',
      },
    );
  });
});

describe('IA da aplicação: research on the house plan (KBC-022 AC-4 to AC-6)', () => {
  it('answers a person with no AI of their own, free, naming the model and the quota left', async () => {
    const started = await start();
    const { owner, member } = await withPeople(started);
    await connectHouse(started, owner);
    const turn = await research(member);
    expect(turn.at(-1)).toMatchObject({
      type: 'done',
      model: 'fake/large:free',
      billing: 'free',
      plan: 'house',
      remaining: 4,
      usd: 0,
    });
    expect(started.fake.chats[0]?.models).toEqual([
      'fake/large:free',
      'fake/small:free',
      'openrouter/free',
    ]);
    expect((await member('GET', '/api/v1/ai/status')).json()).toEqual({
      source: 'app',
      appAi: 'house',
      provider: 'app',
      remainingToday: 4,
      dailyResearches: 5,
      enforced: false,
    });
  });

  it('refuses past the person’s daily quota (deep counts 2)', async () => {
    const started = await start();
    const { owner, member, memberId } = await withPeople(started);
    await connectHouse(started, owner);
    await owner('PATCH', `/api/v1/people/${memberId}`, {
      ai: { dailyResearches: 2 },
    });
    expect((await research(member, 'deep')).at(-1)).toMatchObject({
      type: 'done',
      remaining: 0,
    });
    expect(await research(member, 'fast')).toContainEqual({
      type: 'error',
      code: 'HOUSE_QUOTA_EXHAUSTED',
    });
  });

  it('refuses when the free capacity of the day is short, without spending the quota', async () => {
    const started = await start();
    const { owner, member } = await withPeople(started);
    await connectHouse(started, owner);
    started.fake.freeRemaining = 5;
    expect(await research(member, 'deep')).toContainEqual({
      type: 'error',
      code: 'AI_CAPACITY_EXHAUSTED',
    });
    expect((await member('GET', '/api/v1/ai/status')).json()).toMatchObject({
      remainingToday: 5,
    });
  });

  it('gives the quota back when every free model is busy before answering', async () => {
    const started = await start();
    const { owner, member } = await withPeople(started);
    await connectHouse(started, owner);
    for (const id of ['fake/large:free', 'fake/small:free', 'openrouter/free'])
      started.fake.busy.add(id);
    expect(await research(member)).toContainEqual({
      type: 'error',
      code: 'AI_CAPACITY_EXHAUSTED',
    });
    expect((await member('GET', '/api/v1/ai/status')).json()).toMatchObject({
      remainingToday: 5,
    });
  });
});

describe('The AI access policy (KBC-022 AC-8, AC-12, AC-13)', () => {
  it('assigns the app AI to some people, then to everyone and as the default, with an audit trail', async () => {
    const started = await start();
    const { owner, member, memberId } = await withPeople(started);
    await connectHouse(started, owner);
    const assigned = await owner('POST', '/api/v1/people/ai-assignment', {
      personIds: [memberId],
      appAi: 'house',
    });
    expect(assigned.json()).toEqual({ updated: 1 });
    const all = await owner('POST', '/api/v1/people/ai-assignment', {
      personIds: 'all',
      appAi: 'none',
      setDefault: true,
    });
    expect(all.json()).toEqual({ updated: 2 });
    const people = (await owner('GET', '/api/v1/people')).json().items;
    const ana = people.find((p: { id: string }) => p.id === memberId);
    expect(ana.ai.appAi).toBe('none');
    expect(
      ana.ai.history.map((h: { appAi: string; by: string }) => [h.appAi, h.by]),
    ).toEqual([
      ['house', OWNER_EMAIL],
      ['none', OWNER_EMAIL],
    ]);
    expect((await owner('GET', '/api/v1/house-ai')).json().defaultAppAi).toBe(
      'none',
    );
    expect((await member('GET', '/api/v1/ai/status')).json().source).toBe(
      'none',
    );
    const bad = await owner('POST', '/api/v1/people/ai-assignment', {
      personIds: 'all',
      appAi: 'default',
      setDefault: true,
    });
    expect(bad.statusCode).toBe(400);
  });

  it('lets a person’s own AI win unless the master enforces the app AI', async () => {
    const started = await start();
    const { owner, member, memberId } = await withPeople(started);
    await connectHouse(started, owner);
    started.fake.acceptKey('sk-or-v1-ana-own-5678');
    await member('PUT', '/api/v1/settings', {
      ai: {
        provider: 'openrouter',
        keys: { openrouter: 'sk-or-v1-ana-own-5678' },
      },
    });
    expect((await member('GET', '/api/v1/ai/status')).json()).toMatchObject({
      source: 'own',
      provider: 'openrouter',
    });
    await owner('PATCH', `/api/v1/people/${memberId}`, {
      ai: { enforced: true },
    });
    expect((await member('GET', '/api/v1/ai/status')).json()).toMatchObject({
      source: 'app',
      appAi: 'house',
      enforced: true,
    });
    // The person's key is sealed on disk and never in a response or the log.
    const everything = [
      await statePlain(started.state),
      (await member('GET', '/api/v1/settings')).body,
      (await member('GET', '/api/v1/ai/providers')).body,
      started.logs.join('\n'),
    ].join('\n');
    expect(everything).not.toContain('ana-own');
  });

  it('keeps a person’s OpenRouter key limit in step with their paid fallback', async () => {
    const started = await start();
    const { owner, memberId } = await withPeople(started);
    await connectHouse(started, owner);
    await owner('PUT', '/api/v1/house-ai', {
      paidModel: 'fake/paid',
      managementKey: 'sk-or-v1-mgmt-0001',
    });
    const enable = await owner('PATCH', `/api/v1/people/${memberId}`, {
      ai: { paidFallback: { enabled: true, monthlyCapUsd: 2 } },
    });
    expect(enable.statusCode).toBe(200);
    expect([...started.fake.createdKeys.values()].map((k) => k.limit)).toEqual([
      2,
    ]);
    await owner('PATCH', `/api/v1/people/${memberId}`, {
      ai: { paidFallback: { enabled: true, monthlyCapUsd: 3 } },
    });
    expect([...started.fake.createdKeys.values()].map((k) => k.limit)).toEqual([
      3,
    ]);
    await owner('PATCH', `/api/v1/people/${memberId}`, {
      ai: { paidFallback: { enabled: false, monthlyCapUsd: 3 } },
    });
    expect(started.fake.createdKeys.size).toBe(0);
    expect(await statePlain(started.state)).not.toContain('mgmt-0001');
  });
});
