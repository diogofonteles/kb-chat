import { mkdtemp, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { CSRF_HEADER, CSRF_HEADER_VALUE } from '@kb-chat/contracts';
import { aSearchConversation } from '../../../test/conversation-factories.js';
import { FIXTURE_VAULT } from '../../../test/fixture-paths.js';
import {
  TEST_CLIENT_ID,
  createTestKeys,
  mintIdToken,
  testVerifier,
  type TestKeys,
} from '../../../test/identity-factories.js';
import { FsConversationStore } from '../../adapters/fs-conversation-store.js';
import { FsSessionStore } from '../../adapters/fs-session-store.js';
import { FsVaultAdapter } from '../../adapters/fs-vault-adapter.js';
import { JsonPeopleStore } from '../../adapters/json-people-store.js';
import { JsonSettingsStore } from '../../adapters/json-settings-store.js';
import { JsonlSpendLedger } from '../../adapters/jsonl-spend-ledger.js';
import { buildApp } from '../../app.js';
import { loadConfig } from '../../config.js';
import { createLogger } from '../../logger.js';
import { createAiProviders } from '../../providers/create-ai-providers.js';
import { createResearchAgent } from '../../research-agent-factory.js';
import { createSearchIndex } from '../../search-index-factory.js';
import { CatalogRegistry } from '../catalog/index.js';
import { PeopleService } from './people-service.js';
import { SessionService } from './session-service.js';

const OWNER_EMAIL = 'owner@example.com';
const LOCAL = { host: 'localhost:3000', [CSRF_HEADER]: CSRF_HEADER_VALUE };

interface Started {
  readonly app: FastifyInstance;
  readonly keys: TestKeys;
  readonly state: string;
}

let current: FastifyInstance | null = null;
afterEach(async () => {
  await current?.close();
  current = null;
});

/** The app as main builds it: files under a temporary state folder, the test key as Google. */
async function start(env: Record<string, string> = {}): Promise<Started> {
  const state = await mkdtemp(join(tmpdir(), 'kbchat-auth-'));
  const config = loadConfig({
    KB_VAULT: FIXTURE_VAULT,
    KB_CHAT_SEARCH: 'fixture',
    KB_CHAT_LLM: 'stub',
    KB_CHAT_STATE_DIR: state,
    GOOGLE_CLIENT_ID: TEST_CLIENT_ID,
    KB_CHAT_OWNER_EMAIL: OWNER_EMAIL,
    ALLOWED_HOSTS: 'localhost,kb.example',
    LOG_LEVEL: 'silent',
    ...env,
  });
  return { ...(await assemble(config, state)), state };
}

async function assemble(
  config: ReturnType<typeof loadConfig>,
  state: string,
): Promise<Omit<Started, 'state'>> {
  const keys = await createTestKeys();
  const vault = new FsVaultAdapter(config.KB_VAULT);
  const index = await createSearchIndex({
    config,
    vault,
    log: createLogger('silent'),
  });
  const catalog = new CatalogRegistry(vault);
  await catalog.load();
  const ledger = new JsonlSpendLedger(join(state, 'spend.jsonl'));
  const agent = createResearchAgent({ catalog, index, vault, ledger });
  const ai = await createAiProviders({
    config,
    principal: 'owner',
    store: new JsonSettingsStore(join(state, 'settings')),
    env: { PATH: '' },
    tools: agent.toolsFor,
    perTokenRunner: agent.perTokenRunner,
    systemPrompt: agent.systemPrompt,
  });
  const auth = {
    people: new PeopleService({
      store: new JsonPeopleStore(join(state, 'people.json')),
      ownerEmail: config.KB_CHAT_OWNER_EMAIL,
    }),
    sessions: new SessionService({
      store: new FsSessionStore(join(state, 'sessions')),
    }),
    verifier: testVerifier(keys),
  };
  const conversations = new FsConversationStore({
    dir: join(state, 'conversations'),
    log: createLogger('silent'),
  });
  const app = await buildApp({
    config,
    vault,
    index,
    catalog,
    agent,
    ai,
    ledger,
    conversations,
    auth,
    logger: createLogger('silent'),
  });
  current = app;
  return { app, keys };
}

const cookieOf = (setCookie: unknown): string =>
  String(Array.isArray(setCookie) ? setCookie[0] : setCookie).split(';')[0] ??
  '';

/** Signs in through POST /auth/google with a token for `email`; returns the cookie header. */
async function signIn(
  { app, keys }: Pick<Started, 'app' | 'keys'>,
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

const call =
  (app: FastifyInstance, headers: Record<string, string>) =>
  (method: InjectOptions['method'], url: string, payload?: object) =>
    app.inject({ method, url, headers, ...(payload && { payload }) });

/** A master invites `email` and gives them `grant`; returns the person's id. */
async function invite(
  started: Started,
  owner: Record<string, string>,
  grant: { email: string; topics?: string[]; features?: string[] },
): Promise<string> {
  const as = call(started.app, owner);
  const invited = await as('POST', '/api/v1/people', { email: grant.email });
  expect(invited.statusCode).toBe(201);
  const id: string = invited.json().id;
  const patch = { topics: grant.topics, features: grant.features };
  if (patch.topics || patch.features)
    expect((await as('PATCH', `/api/v1/people/${id}`, patch)).statusCode).toBe(
      200,
    );
  return id;
}

describe('sign-in (BR-1, BR-2)', () => {
  it('AC-1: without a session every route but sign-in and health answers 401', async () => {
    const { app } = await start();
    const anonymous = call(app, LOCAL);

    expect((await anonymous('GET', '/api/v1/topics')).statusCode).toBe(401);
    expect((await anonymous('GET', '/api/v1/topics')).json().error.code).toBe(
      'UNAUTHENTICATED',
    );
    expect((await anonymous('GET', '/api/v1/me')).statusCode).toBe(401);
    expect((await anonymous('GET', '/api/v1/no-such-route')).statusCode).toBe(
      401,
    );
    expect((await anonymous('GET', '/health')).statusCode).toBe(200);
    expect((await anonymous('GET', '/api/v1/auth/config')).json()).toEqual({
      googleClientId: TEST_CLIENT_ID,
    });
  });

  it('opens an httpOnly, SameSite=Lax 30-day session for the owner, without Secure on localhost', async () => {
    const started = await start();
    const credential = await mintIdToken(started.keys, { email: OWNER_EMAIL });

    const response = await started.app.inject({
      method: 'POST',
      url: '/api/v1/auth/google',
      headers: LOCAL,
      payload: { credential },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      email: OWNER_EMAIL,
      role: 'master',
      isOwner: true,
      topics: ['alquimia', 'hermetismo'],
    });
    const setCookie = String(response.headers['set-cookie']);
    expect(setCookie).toMatch(
      /^kbchat_session=[\w-]{43}; Path=\/; HttpOnly; SameSite=Lax; Max-Age=2592000$/,
    );
    const me = await call(started.app, {
      ...LOCAL,
      cookie: cookieOf(setCookie),
    })('GET', '/api/v1/me');
    expect(me.json()).toMatchObject({
      email: OWNER_EMAIL,
      features: ['search', 'research', 'collection-builder', 'own-ai-settings'],
    });
  });

  it('marks the cookie Secure on a hosted name', async () => {
    const started = await start();
    const credential = await mintIdToken(started.keys, { email: OWNER_EMAIL });
    const response = await started.app.inject({
      method: 'POST',
      url: '/api/v1/auth/google',
      headers: {
        ...LOCAL,
        host: 'kb.example',
        origin: 'http://localhost:4200',
      },
      payload: { credential },
    });
    expect(String(response.headers['set-cookie'])).toMatch(/; Secure$/);
  });

  it('AC-2: refuses an account that was not invited, an unverified e-mail and a bad token', async () => {
    const started = await start();
    const login = async (credential: string) =>
      started.app.inject({
        method: 'POST',
        url: '/api/v1/auth/google',
        headers: LOCAL,
        payload: { credential },
      });

    const stranger = await login(
      await mintIdToken(started.keys, { email: 'stranger@example.com' }),
    );
    const unverified = await login(
      await mintIdToken(started.keys, {
        email: OWNER_EMAIL,
        email_verified: false,
      }),
    );
    const forged = await login(
      await mintIdToken(started.keys, { aud: 'another-client' }),
    );

    expect(stranger.statusCode).toBe(403);
    expect(stranger.json().error.code).toBe('NOT_INVITED');
    expect(stranger.headers['set-cookie']).toBeUndefined();
    expect(unverified.statusCode).toBe(401);
    expect(forged.statusCode).toBe(401);
  });

  it('signs out: the cookie is cleared and the old session no longer works', async () => {
    const started = await start();
    const owner = await signIn(started, OWNER_EMAIL);

    const out = await call(started.app, owner)('POST', '/api/v1/auth/logout');

    expect(out.statusCode).toBe(204);
    expect(String(out.headers['set-cookie'])).toContain('kbchat_session=; ');
    expect(String(out.headers['set-cookie'])).toContain('Max-Age=0');
    expect(
      (await call(started.app, owner)('GET', '/api/v1/me')).statusCode,
    ).toBe(401);
  });

  it('refuses state changes without the CSRF header or from another origin', async () => {
    const started = await start();
    const owner = await signIn(started, OWNER_EMAIL);
    const withoutHeader = Object.fromEntries(
      Object.entries(owner).filter(([name]) => name !== CSRF_HEADER),
    );
    const payload = { preferences: { theme: 'dark' } };

    const bare = await call(started.app, withoutHeader)(
      'PUT',
      '/api/v1/settings',
      payload,
    );
    const crossSite = await call(started.app, {
      ...owner,
      origin: 'https://evil.example',
    })('PUT', '/api/v1/settings', payload);
    const sameSite = await call(started.app, {
      ...owner,
      origin: 'http://localhost:4200',
    })('PUT', '/api/v1/settings', payload);

    expect(bare.statusCode).toBe(403);
    expect(bare.json().error.code).toBe('CSRF_REJECTED');
    expect(crossSite.json().error.code).toBe('CSRF_REJECTED');
    expect(sameSite.statusCode).toBe(200);
  });

  it('rate-limits sign-in attempts', async () => {
    const started = await start({ AUTH_RATE_LIMIT: '2' });
    const attempt = () =>
      started.app.inject({
        method: 'POST',
        url: '/api/v1/auth/google',
        headers: LOCAL,
        payload: { credential: 'x'.repeat(40) },
      });
    await attempt();
    await attempt();
    expect((await attempt()).statusCode).toBe(429);
  });
});

describe("the owner's data before logins (migration)", () => {
  it('shows the history, settings and spend saved under `owner` after the first Google sign-in', async () => {
    const state = await mkdtemp(join(tmpdir(), 'kbchat-migrate-'));
    const old = aSearchConversation({ title: 'conversa de antes do login' });
    await new FsConversationStore({
      dir: join(state, 'conversations'),
      log: createLogger('silent'),
    }).put('owner', old);
    await new JsonSettingsStore(join(state, 'settings')).write('owner', {
      version: 1,
      preferences: { theme: 'esoteric' },
    });
    await new JsonlSpendLedger(join(state, 'spend.jsonl')).append({
      ts: new Date().toISOString(),
      principal: 'owner',
      model: 'm',
      inputTokens: 1,
      outputTokens: 1,
      usd: 0.25,
      interrupted: false,
    });
    const config = loadConfig({
      KB_VAULT: FIXTURE_VAULT,
      KB_CHAT_SEARCH: 'fixture',
      KB_CHAT_LLM: 'stub',
      KB_CHAT_STATE_DIR: state,
      GOOGLE_CLIENT_ID: TEST_CLIENT_ID,
      KB_CHAT_OWNER_EMAIL: OWNER_EMAIL,
      LOG_LEVEL: 'silent',
    });
    const started = { ...(await assemble(config, state)), state };

    const owner = call(started.app, await signIn(started, OWNER_EMAIL));

    expect((await owner('GET', '/api/v1/conversations')).json().items).toEqual([
      expect.objectContaining({
        id: old.id,
        title: 'conversa de antes do login',
      }),
    ]);
    expect((await owner('GET', '/api/v1/settings')).json()).toMatchObject({
      exists: true,
      preferences: { theme: 'esoteric' },
    });
    expect((await owner('GET', '/api/v1/spend/today')).json().usd).toBeCloseTo(
      0.25,
    );
    expect((await stat(join(state, 'people.json'))).mode & 0o777).toBe(0o600);
  });
});

describe('permissions per person (FR-4)', () => {
  it('AC-3: a guest with collection A and search sees only A, and B answers 404', async () => {
    const started = await start();
    const owner = await signIn(started, OWNER_EMAIL);
    await invite(started, owner, {
      email: 'guest@example.com',
      topics: ['hermetismo'],
    });
    const guest = call(started.app, await signIn(started, 'guest@example.com'));
    const search = { q: 'ritmo' };

    expect(
      (await guest('GET', '/api/v1/topics'))
        .json()
        .items.map((t: { slug: string }) => t.slug),
    ).toEqual(['hermetismo']);
    expect((await guest('GET', '/api/v1/me')).json()).toMatchObject({
      role: 'member',
      features: ['search'],
      topics: ['hermetismo'],
      isOwner: false,
    });
    expect(
      (await guest('POST', '/api/v1/topics/hermetismo/searches', search))
        .statusCode,
    ).toBe(200);
    const hidden = await guest(
      'POST',
      '/api/v1/topics/alquimia/searches',
      search,
    );
    expect(hidden.statusCode).toBe(404);
    expect(hidden.json().error.code).toBe('TOPIC_NOT_FOUND');
    expect(
      (await guest('GET', '/api/v1/topics/alquimia/facets')).statusCode,
    ).toBe(404);
    expect(
      (await guest('GET', '/api/v1/topics/alquimia/suggestions')).statusCode,
    ).toBe(404);
    expect(
      (await guest('GET', '/api/v1/topics/alquimia/documents/x.md')).statusCode,
    ).toBe(404);
    expect(
      (await guest('GET', '/api/v1/topics/hermetismo/suggestions')).statusCode,
    ).toBe(200);
  });

  it('answers 403 for a missing feature or the master role, and 404 first for an unseen collection', async () => {
    const started = await start();
    const owner = await signIn(started, OWNER_EMAIL);
    await invite(started, owner, {
      email: 'guest@example.com',
      topics: ['hermetismo'],
    });
    const guest = call(started.app, await signIn(started, 'guest@example.com'));
    const question = { question: 'o que é o ritmo?' };

    const research = await guest(
      'POST',
      '/api/v1/topics/hermetismo/research',
      question,
    );
    expect(research.statusCode).toBe(403);
    expect(research.json().error.code).toBe('FORBIDDEN');
    expect(
      (await guest('POST', '/api/v1/topics/alquimia/research', question))
        .statusCode,
    ).toBe(404);
    expect((await guest('GET', '/api/v1/people')).statusCode).toBe(403);
    expect(
      (await guest('POST', '/api/v1/people', { email: 'x@example.com' }))
        .statusCode,
    ).toBe(403);
    expect((await guest('GET', '/api/v1/ai/providers')).statusCode).toBe(403);
    expect(
      (
        await guest('POST', '/api/v1/settings/ai/test', {
          provider: 'openrouter',
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (await guest('PUT', '/api/v1/settings', { ai: { dailyCapUsd: 5 } }))
        .statusCode,
    ).toBe(403);
    expect(
      (
        await guest('PUT', '/api/v1/settings', {
          preferences: { theme: 'dark' },
        })
      ).statusCode,
    ).toBe(200);
    expect((await guest('GET', '/api/v1/spend/today')).statusCode).toBe(200);
    const hiddenDefault = await guest('PUT', '/api/v1/settings', {
      preferences: { defaultTopic: 'alquimia' },
    });
    expect(hiddenDefault.statusCode).toBe(400);
  });

  it('applies a new grant on the next request, and a master reaches every collection', async () => {
    const started = await start();
    const owner = await signIn(started, OWNER_EMAIL);
    const id = await invite(started, owner, {
      email: 'guest@example.com',
      topics: ['hermetismo'],
    });
    const guest = call(started.app, await signIn(started, 'guest@example.com'));

    await call(started.app, owner)('PATCH', `/api/v1/people/${id}`, {
      features: ['search', 'research'],
    });
    const research = await guest('POST', '/api/v1/topics/hermetismo/research', {
      question: 'ritmo?',
    });

    expect(research.statusCode).toBe(200);
    expect(research.headers['content-type']).toContain('text/event-stream');
    expect(
      (
        await call(started.app, owner)(
          'POST',
          '/api/v1/topics/alquimia/searches',
          { q: 'ouro' },
        )
      ).statusCode,
    ).toBe(200);
  });

  it('refuses a grant of a collection that does not exist', async () => {
    const started = await start();
    const owner = await signIn(started, OWNER_EMAIL);
    const id = await invite(started, owner, { email: 'guest@example.com' });
    const response = await call(started.app, owner)(
      'PATCH',
      `/api/v1/people/${id}`,
      { topics: ['nao-existe'] },
    );
    expect(response.statusCode).toBe(400);
  });

  it('AC-4: revoking a guest ends their session on the next call', async () => {
    const started = await start();
    const owner = await signIn(started, OWNER_EMAIL);
    const id = await invite(started, owner, {
      email: 'guest@example.com',
      topics: ['hermetismo'],
    });
    const guest = call(started.app, await signIn(started, 'guest@example.com'));
    expect((await guest('GET', '/api/v1/topics')).statusCode).toBe(200);

    expect(
      (await call(started.app, owner)('DELETE', `/api/v1/people/${id}`))
        .statusCode,
    ).toBe(204);

    expect((await guest('GET', '/api/v1/topics')).statusCode).toBe(401);
  });

  it('AC-5: each person lists only their own history', async () => {
    const started = await start();
    const ownerHeaders = await signIn(started, OWNER_EMAIL);
    await invite(started, ownerHeaders, {
      email: 'guest@example.com',
      topics: ['hermetismo'],
    });
    const owner = call(started.app, ownerHeaders);
    const guest = call(started.app, await signIn(started, 'guest@example.com'));
    const mine = aSearchConversation({ title: 'do dono' });
    const theirs = aSearchConversation({ title: 'do convidado' });

    await owner('PUT', `/api/v1/conversations/${mine.id}`, mine);
    await guest('PUT', `/api/v1/conversations/${theirs.id}`, theirs);

    expect(
      (await owner('GET', '/api/v1/conversations'))
        .json()
        .items.map((c: { title: string }) => c.title),
    ).toEqual(['do dono']);
    expect(
      (await guest('GET', '/api/v1/conversations'))
        .json()
        .items.map((c: { title: string }) => c.title),
    ).toEqual(['do convidado']);
    expect(
      (await guest('GET', `/api/v1/conversations/${mine.id}`)).statusCode,
    ).toBe(404);
    const takeover = await guest('PUT', `/api/v1/conversations/${mine.id}`, {
      ...mine,
      title: 'tomada',
    });
    expect(takeover.statusCode).toBe(404);
    await guest('DELETE', `/api/v1/conversations/${mine.id}`);
    expect(
      (await owner('GET', `/api/v1/conversations/${mine.id}`)).json().title,
    ).toBe('do dono');
  });

  it('AC-7: with two masters one demotes the other, then cannot demote themselves', async () => {
    const started = await start();
    const owner = call(started.app, await signIn(started, OWNER_EMAIL));
    const id = await invite(started, await signIn(started, OWNER_EMAIL), {
      email: 'second@example.com',
      features: ['search'],
    });
    await owner('PATCH', `/api/v1/people/${id}`, { role: 'master' });
    const people = (await owner('GET', '/api/v1/people')).json().items as {
      id: string;
      email: string;
    }[];
    const ownerId = people.find((p) => p.email === OWNER_EMAIL)?.id;

    const first = await owner('PATCH', `/api/v1/people/${id}`, {
      role: 'member',
    });
    const self = await owner('PATCH', `/api/v1/people/${ownerId}`, {
      role: 'member',
    });

    expect(first.statusCode).toBe(200);
    expect(self.statusCode).toBe(409);
    expect(self.json().error.code).toBe('LAST_MASTER');
  });
});

describe('AI for guests (BR-5, KBC-007 BR-6)', () => {
  it('keeps the subscriptions and the environment keys to the owner', async () => {
    const started = await start({
      KB_CHAT_LLM: 'openrouter',
      OPENROUTER_API_KEY: 'sk-or-env-key',
    });
    const ownerHeaders = await signIn(started, OWNER_EMAIL);
    await invite(started, ownerHeaders, {
      email: 'guest@example.com',
      topics: ['hermetismo'],
      features: ['search', 'research', 'own-ai-settings'],
    });
    const guest = call(started.app, await signIn(started, 'guest@example.com'));
    const owner = call(started.app, ownerHeaders);

    const guestList = (await guest('GET', '/api/v1/ai/providers')).json();
    const ownerList = (await owner('GET', '/api/v1/ai/providers')).json();
    const byId = (list: { items: { id: string }[] }, id: string) =>
      list.items.find((p) => p.id === id);

    expect(guestList.active).toBe('none');
    expect(byId(guestList, 'claude-subscription')).toMatchObject({
      available: false,
      reason: 'owner-only',
    });
    expect(byId(guestList, 'openrouter')).toMatchObject({
      keySource: null,
      reason: 'key-missing',
    });
    expect(ownerList.active).toBe('openrouter');
    expect(byId(ownerList, 'openrouter')).toMatchObject({
      keySource: 'env',
      available: true,
    });
    expect(byId(ownerList, 'claude-subscription')).toMatchObject({
      reason: 'cli-missing',
    });
    const choose = await guest('PUT', '/api/v1/settings', {
      ai: { provider: 'claude-subscription' },
    });
    expect(choose.statusCode).toBe(403);
    expect(
      (
        await guest('POST', '/api/v1/topics/hermetismo/research', {
          question: 'ritmo?',
        })
      ).statusCode,
    ).toBe(409);
  });
});

describe('spend per person (BR-6)', () => {
  it("shows the owner each person's spend today, and nobody else", async () => {
    const started = await start();
    const ownerHeaders = await signIn(started, OWNER_EMAIL);
    const id = await invite(started, ownerHeaders, {
      email: 'guest@example.com',
      topics: ['hermetismo'],
    });
    const guestHeaders = await signIn(started, 'guest@example.com');
    await new JsonlSpendLedger(join(started.state, 'spend.jsonl')).append({
      ts: new Date().toISOString(),
      principal: 'sub-guest@example.com',
      model: 'm',
      inputTokens: 1,
      outputTokens: 1,
      usd: 0.5,
      interrupted: false,
    });

    const seen = await call(started.app, ownerHeaders)(
      'GET',
      '/api/v1/spend/people',
    );

    expect(seen.statusCode).toBe(200);
    expect(seen.json().items).toEqual(
      expect.arrayContaining([
        { email: OWNER_EMAIL, usd: 0 },
        { email: 'guest@example.com', usd: 0.5 },
      ]),
    );
    expect(
      (await call(started.app, guestHeaders)('GET', '/api/v1/spend/people'))
        .statusCode,
    ).toBe(403);
    await call(started.app, ownerHeaders)('PATCH', `/api/v1/people/${id}`, {
      role: 'master',
    });
    expect(
      (await call(started.app, guestHeaders)('GET', '/api/v1/spend/people'))
        .statusCode,
    ).toBe(403);
  });
});
