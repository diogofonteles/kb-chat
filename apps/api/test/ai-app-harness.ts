/** The app as main builds it, for the AI integration tests (KBC-022, KBC-023). */
import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import type {
  FastifyBaseLogger,
  FastifyInstance,
  InjectOptions,
  LightMyRequestResponse,
} from 'fastify';
import { expect } from 'vitest';
import {
  CSRF_HEADER,
  CSRF_HEADER_VALUE,
  researchEventSchema,
  type ResearchEvent,
} from '@kb-chat/contracts';
import pino from 'pino';
import { FIXTURE_VAULT } from './fixture-paths.js';
import {
  TEST_CLIENT_ID,
  createTestKeys,
  mintIdToken,
  testVerifier,
  type TestKeys,
} from './identity-factories.js';
import { FsSessionStore } from '../src/adapters/fs-session-store.js';
import { FsVaultAdapter } from '../src/adapters/fs-vault-adapter.js';
import { JsonPeopleStore } from '../src/adapters/json-people-store.js';
import { JsonSettingsStore } from '../src/adapters/json-settings-store.js';
import { JsonlSpendLedger } from '../src/adapters/jsonl-spend-ledger.js';
import { SealedSettingsStore } from '../src/adapters/sealed-settings-store.js';
import { SecretBox } from '../src/adapters/secret-box.js';
import { buildApp } from '../src/app.js';
import { loadConfig, type AppConfig } from '../src/config.js';
import { createHouseAi } from '../src/house-ai-factory.js';
import { PeopleService, SessionService } from '../src/modules/auth/index.js';
import { CatalogRegistry } from '../src/modules/catalog/index.js';
import { createAiProviders } from '../src/providers/create-ai-providers.js';
import { createResearchAgent } from '../src/research-agent-factory.js';
import { createSearchIndex } from '../src/search-index-factory.js';
import { FakeOpenRouter } from '../src/testing/fake-openrouter.js';
import { FakeGemini, fakeProvidersFetch } from '../src/testing/fake-gemini.js';
import type { SpendLedgerPort } from '../src/ports/spend-ledger.js';

export const OWNER_EMAIL = 'owner@example.com';
export const WEB = 'http://localhost:4200';
export const LOCAL = {
  host: 'localhost:3000',
  [CSRF_HEADER]: CSRF_HEADER_VALUE,
};

export interface Started {
  readonly app: FastifyInstance;
  readonly keys: TestKeys;
  readonly state: string;
  readonly fake: FakeOpenRouter;
  readonly gemini: FakeGemini;
  readonly ledger: SpendLedgerPort;
  readonly logs: string[];
}

let current: FastifyInstance | null = null;

/** Closes the app the last `start()` built (call it in `afterEach`). */
export async function closeApp(): Promise<void> {
  await current?.close();
  current = null;
}

function testConfig(state: string) {
  return loadConfig({
    KB_VAULT: FIXTURE_VAULT,
    KB_CHAT_SEARCH: 'fixture',
    KB_CHAT_STATE_DIR: state,
    GOOGLE_CLIENT_ID: TEST_CLIENT_ID,
    KB_CHAT_OWNER_EMAIL: OWNER_EMAIL,
    WEB_ORIGIN: WEB,
    LOG_LEVEL: 'info',
  });
}

/** A logger whose lines are kept, so a test can look for secrets in them. */
function capturedLogger() {
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
  return { logs, logger };
}

function testAuth(state: string, keys: TestKeys) {
  return {
    people: new PeopleService({
      store: new JsonPeopleStore(join(state, 'people.json')),
      ownerEmail: OWNER_EMAIL,
    }),
    sessions: new SessionService({
      store: new FsSessionStore(join(state, 'sessions')),
    }),
    verifier: testVerifier(keys),
  };
}

/** The vault, its index and catalog, the spend ledger and the research agent. */
async function buildCore(config: AppConfig, logger: FastifyBaseLogger) {
  const vault = new FsVaultAdapter(config.KB_VAULT);
  const index = await createSearchIndex({ config, vault, log: logger });
  const catalog = new CatalogRegistry(vault);
  await catalog.load();
  const ledger = new JsonlSpendLedger(
    join(config.KB_CHAT_STATE_DIR, 'spend.jsonl'),
  );
  const agent = createResearchAgent({ catalog, index, vault, ledger });
  return { vault, index, catalog, ledger, agent };
}

interface AiWiring {
  readonly config: AppConfig;
  readonly core: Awaited<ReturnType<typeof buildCore>>;
  readonly auth: ReturnType<typeof testAuth>;
  readonly fetch: typeof fetch;
}

/** The house plan and the providers, every key sealed (ADR 0017). */
async function buildAi({ config, core, auth, fetch }: AiWiring) {
  const state = config.KB_CHAT_STATE_DIR;
  const sealer = new SecretBox(randomBytes(32));
  const house = await createHouseAi({
    stateDir: state,
    sealer,
    webOrigin: WEB,
    fetch,
  });
  const ai = await createAiProviders({
    config,
    principal: 'owner',
    store: new SealedSettingsStore({
      store: new JsonSettingsStore(join(state, 'settings')),
      sealer,
    }),
    env: { PATH: '' },
    fetch,
    tools: core.agent.toolsFor,
    perTokenRunner: core.agent.perTokenRunner,
    systemPrompt: core.agent.systemPrompt,
    house,
    personOf: (principal) => auth.people.cachedByPrincipal(principal),
    ledger: core.ledger,
  });
  return { house, ai };
}

/** The app as main builds it, with sealed settings and fake OpenRouter and Gemini. */
export async function start(): Promise<Started> {
  const state = await mkdtemp(join(tmpdir(), 'kbchat-house-'));
  const config = testConfig(state);
  const { logs, logger } = capturedLogger();
  const fake = new FakeOpenRouter();
  const gemini = new FakeGemini();
  const fetch = fakeProvidersFetch({
    openrouter: fake.fetch,
    gemini: gemini.fetch,
  });
  const keys = await createTestKeys();
  const core = await buildCore(config, logger);
  const auth = testAuth(state, keys);
  const { house, ai } = await buildAi({ config, core, auth, fetch });
  current = await buildApp({ config, ...core, ai, auth, house, logger });
  return { app: current, keys, state, fake, gemini, ledger: core.ledger, logs };
}

const cookieOf = (setCookie: unknown): string =>
  String(Array.isArray(setCookie) ? setCookie[0] : setCookie).split(';')[0] ??
  '';

export async function signIn(
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

export type Call = (
  method: InjectOptions['method'],
  url: string,
  payload?: object,
) => Promise<LightMyRequestResponse>;

export const caller =
  (app: FastifyInstance, headers: Record<string, string>): Call =>
  (method, url, payload) =>
    app.inject({ method, url, headers, ...(payload && { payload }) });

/** The owner (master) and an invited member with research on the fixture collection. */
export async function withPeople(started: Started) {
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
export async function connectHouse(started: Started, owner: Call) {
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

export const events = (body: string): ResearchEvent[] =>
  body
    .split('\n\n')
    .filter((block) => block.startsWith('data: '))
    .map((block) => researchEventSchema.parse(JSON.parse(block.slice(6))));

export const research = async (call: Call, profile = 'fast') =>
  events(
    (
      await call('POST', '/api/v1/topics/hermetismo/research', {
        question: 'O que é o mentalismo?',
        profile,
      })
    ).body,
  );

export const statePlain = async (state: string): Promise<string> => {
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
