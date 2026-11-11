import { createMedia } from '../media-factory.js';
import { registerTranscriberClock } from './transcriber-clock-routes.js';
import { registerTranscriptSeed } from './transcript-seed-routes.js';
import { registerDiarizationSeed } from './diarization-seed-routes.js';
import { registerProposalSeed } from './proposal-seed-routes.js';
import { registerKbPublishMac } from './kb-publish-routes.js';
import { registerLevelArrivals } from './level-arrival-routes.js';
import { startMediaWorkers } from './media-worker-runner.js';
import { privateTemp } from '../../../../tools/test-temp.mjs';
import { cpSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FsVaultAdapter } from '../adapters/fs-vault-adapter.js';
import { OWNER, buildApp } from '../app.js';
import { levelsOnDisk } from '../levels-factory.js';
import { loadConfig } from '../config.js';
import { createLogger } from '../logger.js';
import { JsonlSpendLedger } from '../adapters/jsonl-spend-ledger.js';
import { JsonlUsageLog } from '../adapters/jsonl-usage-log.js';
import { FsConversationStore } from '../adapters/fs-conversation-store.js';
import { JsonSettingsStore } from '../adapters/json-settings-store.js';
import { createAiProviders } from '../providers/create-ai-providers.js';
import { AuthorDirectory, AuthorsService } from '../modules/authors/index.js';
import { CatalogRegistry } from '../modules/catalog/index.js';
import {
  CollectionRegistry,
  CollectionsVault,
} from '../modules/topics/index.js';
import {
  budgetsFromConfig,
  createResearchAgent,
} from '../research-agent-factory.js';
import { createSearchIndex } from '../search-index-factory.js';
import { MemorySessionStore } from '../adapters/memory-session-store.js';
import { JsonPeopleStore } from '../adapters/json-people-store.js';
import { PeopleService, SessionService } from '../modules/auth/index.js';
import { E2E_CLIENT_ID, createTestIdentity } from './test-identity.js';
import { MemoryDocumentStore } from '../adapters/memory-document-store.js';
import { JsonDocumentStore } from '../adapters/json-document-store.js';
import { MemoryOutbox } from '../adapters/memory-outbox.js';
import { registerOutbox } from './outbox-routes.js';
import { SealedSettingsStore } from '../adapters/sealed-settings-store.js';
import { SecretBox } from '../adapters/secret-box.js';
import { createHouseAi } from '../house-ai-factory.js';
import { FakeOpenRouter } from '../testing/fake-openrouter.js';
import { startCodexRunner } from '../codex-runner/runner-server.js';
import { DisabledLlm } from '../adapters/disabled-llm.js';
import { MemorySpendLedger } from '../adapters/memory-spend-ledger.js';
import { StubLlmAdapter } from '../adapters/stub-llm-adapter.js';
import { FakeGemini, fakeProvidersFetch } from '../testing/fake-gemini.js';
import { FakeGroq } from '../testing/fake-groq.js';
import {
  E2E_AUTHORIZE_PATH,
  registerOpenRouterConsent,
} from './openrouter-routes.js';

/** Not a secret: the E2E server's media worker token (local, throwaway). */
const E2E_MEDIA_WORKER_TOKEN = 'e2e-media-worker-token-0123456789abcdef';

// Started by hand (no Playwright around it), it still cleans up after itself.
privateTemp();

/** The owner of the E2E run: a master with the `owner` data the specs expect. */
export const E2E_OWNER_EMAIL = 'owner@kb-chat.test';

// Codex's sandbox runner (KBC-027, ADR 0020), here in-process with the fake Codex: Codex
// turns take the production path (runner, then the turn's MCP endpoint by token).
const codexRunner = await startCodexRunner({
  bin: fileURLToPath(
    new URL('../../test/fakes/fake-codex.mjs', import.meta.url),
  ),
  codexHome: mkdtempSync(join(tmpdir(), 'kbchat-e2e-codex-')),
  mcpUrl: `http://127.0.0.1:${process.env['PORT'] ?? '3000'}/mcp/turn`,
  host: '127.0.0.1',
  port: 0,
  env: { PATH: process.env['PATH'] ?? '' },
});

/**
 * A copy of the fixture vault: the fake Mac (KBC-099) writes track documents into it, and the
 * checked-in fixture stays as it is.
 */
function vaultCopy(): string {
  const copy = mkdtempSync(join(tmpdir(), 'kbchat-e2e-vault-'));
  cpSync(
    fileURLToPath(new URL('../../test/fixtures/vault', import.meta.url)),
    copy,
    { recursive: true },
  );
  levelCollections(copy);
  return copy;
}

/**
 * A latency bench (KBC-101 NFR-3) runs this server on a seeded vault indexed by QMD and a
 * seeded media.db (src/scripts/seed-track-world.ts); the specs never set these.
 */
const BENCH_VAULT = process.env['KBC_BENCH_VAULT'];
const BENCH_MEDIA_DIR = process.env['KBC_BENCH_MEDIA_DIR'];

const LEVEL_DOCS = [
  ['aberto', 'Orvalho Aberto', 'O orvalho da manhã, para todos.'],
  ['medio', 'Orvalho do Meio', 'O orvalho do grau do meio.'],
  ['velado', 'Orvalho Velado', 'O orvalho do grau velado.'],
] as const;

const LEVEL_COLLECTION_NAMES: Record<string, string> = {
  niveis: 'Zz Níveis',
  historico: 'Zz Histórico',
  semnivel: 'Zz Sem Nível',
  pessoas: 'Zz Pessoas',
  gestao: 'Zz Gestão',
};

/**
 * One collection with three documents per Playwright project (KBC-103, e2e/specs/levels.spec):
 * a scale changes what everyone sees in a collection, so the parallel projects never share
 * one, and no other spec's collection gets levels.
 */
function levelCollections(root: string): void {
  // `zz-historico-*`: the stored answers re-checked at today's level (KBC-110).
  // `zz-semnivel-*`: documents arriving without a level (KBC-107).
  // `zz-pessoas-*`: people's levels in profiles, invitations and in bulk (KBC-109).
  // `zz-gestao-*`: a level deleted, a move previewed, every level taken away (KBC-108).
  const kinds = ['niveis', 'historico', 'semnivel', 'pessoas', 'gestao'];
  const collections = kinds.flatMap(
    (kind) => ['desktop', 'mobile'].map((project) => ({ kind, project })),
  );
  for (const { kind, project } of collections) {
    const dir = join(root, `zz-${kind}-${project}`);
    const name = LEVEL_COLLECTION_NAMES[kind] ?? kind;
    mkdirSync(join(dir, 'raw'), { recursive: true });
    writeFileSync(join(dir, 'topic.yaml'), `title: ${name} ${project}\n`);
    for (const [file, title, body] of LEVEL_DOCS)
      writeFileSync(
        join(dir, 'raw', `${file}.md`),
        `---\ntitle: ${title}\ngenre: reference_docs\ndepth: 1\nrelevance: collected_on_purpose\n---\n\n${body}\n`,
      );
  }
}

// E2E server: the fixture vault and the in-process index, no QMD or models.
const config = loadConfig({
  ...process.env,
  KB_VAULT: BENCH_VAULT ?? vaultCopy(),
  KB_CHAT_SEARCH: BENCH_VAULT ? 'qmd' : 'fixture',
  KB_CHAT_LLM: 'stub',
  KB_CHAT_STATE_DIR: mkdtempSync(join(tmpdir(), 'kbchat-e2e-')),
  LOG_LEVEL: 'warn',
  GOOGLE_CLIENT_ID: E2E_CLIENT_ID,
  KB_CHAT_OWNER_EMAIL: E2E_OWNER_EMAIL,
  // Every spec signs in; they run in parallel from one address.
  AUTH_RATE_LIMIT: '10000',
  // Every spec researches from the same address, at both widths.
  RESEARCH_RATE_LIMIT: '10000',
  MEDIA_CREATE_RATE_LIMIT: '10000',
  KB_CHAT_CODEX_RUNNER_URL: codexRunner.url,
  // The media library (KBC-034) with the real worker below and real ffmpeg.
  KB_CHAT_MEDIA: 'on',
  KB_CHAT_MEDIA_DIR:
    BENCH_MEDIA_DIR ?? mkdtempSync(join(tmpdir(), 'kbchat-e2e-media-')),
  KB_CHAT_MEDIA_WORKER_TOKEN: E2E_MEDIA_WORKER_TOKEN,
  // "Ligar transcritor" (KBC-114), with the fake launchctl below: never the real one.
  KB_CHAT_LOCAL_TRANSCRIBER: '1',
});
const logger = createLogger(config.LOG_LEVEL);
const collections = new CollectionRegistry(
  new JsonDocumentStore(join(config.KB_CHAT_STATE_DIR, 'collections.json')),
);
const vault = new CollectionsVault(
  new FsVaultAdapter(config.KB_VAULT),
  collections,
);
const index = await createSearchIndex({ config, vault, log: logger });
const ledger = new JsonlSpendLedger(
  join(config.KB_CHAT_STATE_DIR, 'spend.jsonl'),
);
const catalog = new CatalogRegistry(vault);
await catalog.load();
// The authors of each collection (KBC-049, ADR 0030), in the state dir like the registry.
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
  budgets: budgetsFromConfig(config),
  mainAuthorOf: (topic) => authors.mainVoiceOf(topic),
});
// Providers answer through a fake HTTP layer: a key ending in "valid" is accepted, any other
// gets 401 (KBC-007 AC-5). Nothing leaves this computer.
const fakeProviderFetch: typeof fetch = async (_url, init) => {
  const headers = new Headers(init?.headers);
  const key =
    headers.get('x-api-key') ??
    headers.get('authorization')?.replace(/^Bearer /, '');
  if (!key?.endsWith('valid')) return new Response('{}', { status: 401 });
  return new Response(
    'data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n',
  );
};
// OpenRouter (KBC-022, KBC-023) and Gemini (KBC-023): fakes, the consent page served below.
const openRouter = new FakeOpenRouter();
openRouter.acceptValidSuffix = true;
const gemini = new FakeGemini();
const providersFetch = fakeProvidersFetch({
  openrouter: (input, init) => openRouter.fetch(input, init),
  gemini: (input, init) => gemini.fetch(input, init),
  others: fakeProviderFetch,
});
const sealer = new SecretBox(Buffer.alloc(32, 7));
// The owner's settings already exist, so the first-run wizard stays away from the other specs;
// the wizard's spec fakes a first run in the browser.
const settingsStore = new SealedSettingsStore({
  store: new JsonSettingsStore(join(config.KB_CHAT_STATE_DIR, 'settings')),
  sealer,
});
await settingsStore.write(OWNER, { version: 1 });
// Sign-in against the test identity (never Google): KBC-010.
const identity = await createTestIdentity(config.PORT);
const auth = {
  people: new PeopleService({
    store: new JsonPeopleStore(join(config.KB_CHAT_STATE_DIR, 'people.json')),
    ownerEmail: config.KB_CHAT_OWNER_EMAIL,
  }),
  sessions: new SessionService({ store: new MemorySessionStore() }),
  verifier: identity.verifier,
};
// Only the people a spec lends it to use the house plan: the other specs keep the stub.
await new JsonDocumentStore(
  join(config.KB_CHAT_STATE_DIR, 'house-ai.json'),
).write({
  version: 1,
  defaultAppAi: 'none',
});
const house = await createHouseAi({
  stateDir: config.KB_CHAT_STATE_DIR,
  sealer,
  webOrigin: config.WEB_ORIGIN,
  fetch: openRouter.fetch,
  authorizeUrl: `http://127.0.0.1:${config.PORT}${E2E_AUTHORIZE_PATH}`,
});
/** A lent subscription that answers with the stub model, available while `available` says. */
const stubSubscription = (available: () => boolean) => ({
  available,
  llm: () => new DisabledLlm(),
  runner: () =>
    agent.perTokenRunner(new StubLlmAdapter(), {
      principal: 'lent-subscription',
      dailyCapUsd: () => Number.POSITIVE_INFINITY,
      ledger: new MemorySpendLedger(),
    }),
  failed: () => undefined,
});
const ai = await createAiProviders({
  config,
  principal: OWNER,
  store: settingsStore,
  // No claude or codex on this PATH: subscriptions show as not installed.
  env: { PATH: '/usr/bin:/bin' },
  fetch: providersFetch,
  tools: agent.toolsFor,
  perTokenRunner: agent.perTokenRunner,
  systemPrompt: agent.systemPrompt,
  house,
  personOf: (principal) => auth.people.cachedByPrincipal(principal),
  ledger,
  // No Claude Code here: the owner's lent Claude subscription (KBC-024) answers with the stub,
  // in its own ledger; the ChatGPT one goes to the runner above, as in production.
  subscriptions: {
    'claude-subscription': stubSubscription(() => true),
  },
});
// Today's spend starts at US$ 0.03 so the side panel has a known value (KBC-005 AC-8).
await ledger.append({
  ts: new Date().toISOString(),
  principal: OWNER,
  model: 'stub',
  inputTokens: 0,
  outputTokens: 0,
  usd: 0.03,
  interrupted: false,
});
const usage = new JsonlUsageLog(join(config.KB_CHAT_STATE_DIR, 'events.jsonl'));
const conversations = new FsConversationStore({
  dir: join(config.KB_CHAT_STATE_DIR, 'conversations'),
  log: logger,
});
// Codes and notices land in memory; the specs read them under /api/e2e/outbox (KBC-014).
const outbox = new MemoryOutbox();
const access = {
  codes: new MemoryDocumentStore(),
  requests: new MemoryDocumentStore(),
  delivery: { email: outbox, sms: null },
};
// Groq (KBC-037) answers through a fake: a key ending in "valid" is accepted. Nothing paid.
const media = await createMedia(
  config,
  {
    tokenKey: Buffer.alloc(32, 9),
    voicePrintKey: Buffer.alloc(32, 10),
    consentKey: Buffer.alloc(32, 11),
    groqKey: Buffer.alloc(32, 12),
  },
  {
    fetch: new FakeGroq().fetch,
    launchctl: () =>
      Promise.resolve({ code: 0, output: 'kickstarted (E2E fake)' }),
  },
);
const app = await buildApp({
  config,
  auth,
  access,
  media,
  vault,
  index,
  logger,
  catalog,
  agent,
  ai,
  ledger,
  usage,
  conversations,
  house,
  collections,
  authorDirectory,
  levels: levelsOnDisk(config.KB_CHAT_STATE_DIR),
});
identity.register(app);
registerOutbox(app, outbox);
registerLevelArrivals(app, { vault: config.KB_VAULT, catalog });
if (media) {
  registerTranscriberClock(app, media.transcribers);
  registerTranscriptSeed(app, { media, mediaDir: config.KB_CHAT_MEDIA_DIR });
  registerDiarizationSeed(app, { media, mediaDir: config.KB_CHAT_MEDIA_DIR });
  registerProposalSeed(app, { mediaDir: config.KB_CHAT_MEDIA_DIR });
  registerKbPublishMac(app, {
    media,
    catalog,
    authors,
    vault: config.KB_VAULT,
    mediaDir: config.KB_CHAT_MEDIA_DIR,
  });
}
registerOpenRouterConsent(app, openRouter);
await app.listen({ host: '127.0.0.1', port: config.PORT });
const stopWorkers = startMediaWorkers({
  apiUrl: `http://127.0.0.1:${config.PORT}`,
  token: E2E_MEDIA_WORKER_TOKEN,
  mediaDir: config.KB_CHAT_MEDIA_DIR,
  log: logger,
});
// A stop signal ends the whole server: never an API left running without its workers
// (a later run would reuse it and its uploads would wait in the queue forever).
for (const signal of ['SIGTERM', 'SIGINT'] as const)
  process.once(signal, () => {
    stopWorkers();
    void app.close().finally(() => process.exit(0));
  });
