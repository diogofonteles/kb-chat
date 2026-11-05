/** The app as main builds it, for the AI integration tests (KBC-022, KBC-023). */
import { createMedia } from '../src/media-factory.js';
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
import { FAKES_DIR, FIXTURE_VAULT } from './fixture-paths.js';
import { freePort } from './free-port.js';
import {
  TEST_CLIENT_ID,
  createTestKeys,
  mintIdToken,
  testVerifier,
  type TestKeys,
} from './identity-factories.js';
import { FsSessionStore } from '../src/adapters/fs-session-store.js';
import { FsVaultAdapter } from '../src/adapters/fs-vault-adapter.js';
import { JsonDocumentStore } from '../src/adapters/json-document-store.js';
import {
  CollectionRegistry,
  CollectionsVault,
} from '../src/modules/topics/index.js';
import { JsonPeopleStore } from '../src/adapters/json-people-store.js';
import { JsonSettingsStore } from '../src/adapters/json-settings-store.js';
import { JsonlSpendLedger } from '../src/adapters/jsonl-spend-ledger.js';
import { SealedSettingsStore } from '../src/adapters/sealed-settings-store.js';
import { SecretBox } from '../src/adapters/secret-box.js';
import { buildApp } from '../src/app.js';
import { loadConfig, type AppConfig } from '../src/config.js';
import { createHouseAi } from '../src/house-ai-factory.js';
import { PeopleService, SessionService } from '../src/modules/auth/index.js';
import {
  AuthorDirectory,
  AuthorsService,
} from '../src/modules/authors/index.js';
import { CatalogRegistry } from '../src/modules/catalog/index.js';
import { createAiProviders } from '../src/providers/create-ai-providers.js';
import { createResearchAgent } from '../src/research-agent-factory.js';
import { createSearchIndex } from '../src/search-index-factory.js';
import { FakeOpenRouter } from '../src/testing/fake-openrouter.js';
import { FakeGemini, fakeProvidersFetch } from '../src/testing/fake-gemini.js';
import { FakeGroq } from '../src/testing/fake-groq.js';
import {
  startCodexRunner,
  type CodexRunner,
} from '../src/codex-runner/runner-server.js';
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
  /** Groq for the media library (KBC-037). */
  readonly groq: FakeGroq;
  readonly ledger: SpendLedgerPort;
  readonly logs: string[];
}

let current: FastifyInstance | null = null;

/** Stops the Codex runner the last `start({ codexHome })` started (its container going down). */
export async function stopCodexRunner(): Promise<void> {
  await runner?.close();
  runner = null;
}

/** What the Codex runner counted so far (turns, login checks). */
export const codexRunnerCounts = () =>
  runner?.counts() ?? { turns: 0, statusChecks: 0 };

/** Closes the app the last `start()` built (call it in `afterEach`). */
export async function closeApp(): Promise<void> {
  await current?.close();
  current = null;
  await runner?.close();
  runner = null;
}

/** Options of `start()`: `claude` runs the fake Claude CLI, reached over a real port. */
export interface StartOptions {
  readonly claude?: boolean;
  /** Codex through its sandbox runner (KBC-027), with the fake Codex and this home. */
  readonly codexHome?: string;
  /** An existing state folder (a restart over the same files). */
  readonly state?: string;
  /** The media library on (KBC-034), under `<state>/media`, with MEDIA_WORKER_TOKEN. */
  readonly media?: boolean;
  /** Another vault than the fixture one (a copy with sub-collections, KBC-048). */
  readonly vault?: string;
  /** Settings on top of the test ones. */
  readonly env?: Readonly<Record<string, string>>;
}

/** The media worker token of `start({ media: true })`. */
export const MEDIA_WORKER_TOKEN = 'test-media-worker-token-0123456789abcdef';

let runner: CodexRunner | null = null;

async function testConfig(state: string, options: StartOptions) {
  const port = String(await freePort());
  const cli = options.claude
    ? { CLAUDE_BIN: join(FAKES_DIR, 'fake-claude.mjs'), PORT: port }
    : {};
  const codex = options.codexHome
    ? await codexSandbox(options.codexHome, port)
    : {};
  return loadConfig({
    ...cli,
    ...codex,
    // The Codex sandbox's address in production (ADR 0020): MCP only, by token.
    KB_CHAT_MCP_PEERS: '172.30.0.10',
    KB_VAULT: options.vault ?? FIXTURE_VAULT,
    KB_CHAT_SEARCH: 'fixture',
    KB_CHAT_STATE_DIR: state,
    GOOGLE_CLIENT_ID: TEST_CLIENT_ID,
    KB_CHAT_OWNER_EMAIL: OWNER_EMAIL,
    WEB_ORIGIN: WEB,
    LOG_LEVEL: 'info',
    ...(options.media && {
      KB_CHAT_MEDIA: 'on',
      KB_CHAT_MEDIA_DIR: join(state, 'media'),
      KB_CHAT_MEDIA_WORKER_TOKEN: MEDIA_WORKER_TOKEN,
    }),
    ...options.env,
  });
}

/** A Codex sandbox runner on loopback, running the fake Codex (ADR 0020). */
async function codexSandbox(codexHome: string, port: string) {
  runner = await startCodexRunner({
    bin: join(FAKES_DIR, 'fake-codex.mjs'),
    codexHome,
    mcpUrl: `http://127.0.0.1:${port}/mcp/turn`,
    host: '127.0.0.1',
    port: 0,
    env: { PATH: process.env['PATH'] ?? '' },
  });
  return {
    PORT: port,
    KB_CHAT_CODEX_RUNNER_URL: runner.url,
  };
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
  const collections = new CollectionRegistry(
    new JsonDocumentStore(join(config.KB_CHAT_STATE_DIR, 'collections.json')),
  );
  const vault = new CollectionsVault(
    new FsVaultAdapter(config.KB_VAULT),
    collections,
  );
  const index = await createSearchIndex({ config, vault, log: logger });
  const catalog = new CatalogRegistry(vault);
  await catalog.load();
  const ledger = new JsonlSpendLedger(
    join(config.KB_CHAT_STATE_DIR, 'spend.jsonl'),
  );
  // The authors of each collection (KBC-049), as main builds them.
  const authorDirectory = new AuthorDirectory(
    new JsonDocumentStore(join(config.KB_CHAT_STATE_DIR, 'authors.json')),
  );
  await authorDirectory.load();
  const authors = new AuthorsService({ directory: authorDirectory, catalog });
  const agent = createResearchAgent({
    catalog,
    index,
    vault,
    ledger,
    mainAuthorOf: (topic) => authors.mainVoiceOf(topic),
  });
  return { vault, index, catalog, ledger, agent, collections, authorDirectory };
}

interface AiWiring {
  readonly config: AppConfig;
  readonly core: Awaited<ReturnType<typeof buildCore>>;
  readonly auth: ReturnType<typeof testAuth>;
  readonly fetch: typeof fetch;
  /** What the CLIs inherit: no PATH unless the fake CLI must start. */
  readonly env: NodeJS.ProcessEnv;
}

/** The house plan and the providers, every key sealed (ADR 0017). */
async function buildAi({ config, core, auth, fetch, env }: AiWiring) {
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
    env,
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

/** OpenRouter and Gemini without the network, behind one fetch. */
function fakeProviders() {
  const fake = new FakeOpenRouter();
  const gemini = new FakeGemini();
  const fetch = fakeProvidersFetch({
    openrouter: fake.fetch,
    gemini: gemini.fetch,
  });
  return { fake, gemini, fetch };
}

/** The media library when on, with fresh keys and the fake Groq (KBC-037). */
const testMedia = (config: AppConfig, groq: FakeGroq) =>
  createMedia(
    config,
    {
      tokenKey: randomBytes(32),
      voicePrintKey: randomBytes(32),
      consentKey: randomBytes(32),
      groqKey: randomBytes(32),
    },
    { fetch: groq.fetch },
  );

/** The app as main builds it, with sealed settings and fake OpenRouter and Gemini. */
export async function start(options: StartOptions = {}): Promise<Started> {
  const state =
    options.state ?? (await mkdtemp(join(tmpdir(), 'kbchat-house-')));
  const config = await testConfig(state, options);
  const env = options.claude
    ? { PATH: process.env['PATH'] ?? '', HOME: state }
    : { PATH: '' };
  const { logs, logger } = capturedLogger();
  const { fake, gemini, fetch } = fakeProviders();
  const keys = await createTestKeys();
  const core = await buildCore(config, logger);
  const auth = testAuth(state, keys);
  const { house, ai } = await buildAi({ config, core, auth, fetch, env });
  const groq = new FakeGroq();
  const media = await testMedia(config, groq);
  current = await buildApp({ config, ...core, ai, auth, house, logger, media });
  // The CLI reaches the turn's MCP endpoint over HTTP, so this app really listens.
  if (options.claude || options.codexHome)
    await current.listen({ host: '127.0.0.1', port: config.PORT });
  return {
    app: current,
    keys,
    state,
    fake,
    gemini,
    groq,
    ledger: core.ledger,
    logs,
  };
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
