import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FsVaultAdapter } from '../adapters/fs-vault-adapter.js';
import { OWNER, buildApp } from '../app.js';
import { loadConfig } from '../config.js';
import { createLogger } from '../logger.js';
import { JsonlSpendLedger } from '../adapters/jsonl-spend-ledger.js';
import { JsonlUsageLog } from '../adapters/jsonl-usage-log.js';
import { FsConversationStore } from '../adapters/fs-conversation-store.js';
import { JsonSettingsStore } from '../adapters/json-settings-store.js';
import { createAiProviders } from '../providers/create-ai-providers.js';
import { CatalogRegistry } from '../modules/catalog/index.js';
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
import { MemoryOutbox } from '../adapters/memory-outbox.js';
import { registerOutbox } from './outbox-routes.js';

/** The owner of the E2E run: a master with the `owner` data the specs expect. */
export const E2E_OWNER_EMAIL = 'owner@kb-chat.test';

// E2E server: the fixture vault and the in-process index, no QMD or models.
const config = loadConfig({
  ...process.env,
  KB_VAULT: fileURLToPath(
    new URL('../../test/fixtures/vault', import.meta.url),
  ),
  KB_CHAT_SEARCH: 'fixture',
  KB_CHAT_LLM: 'stub',
  KB_CHAT_STATE_DIR: mkdtempSync(join(tmpdir(), 'kbchat-e2e-')),
  LOG_LEVEL: 'warn',
  GOOGLE_CLIENT_ID: E2E_CLIENT_ID,
  KB_CHAT_OWNER_EMAIL: E2E_OWNER_EMAIL,
  // Every spec signs in; they run in parallel from one address.
  AUTH_RATE_LIMIT: '10000',
});
const logger = createLogger(config.LOG_LEVEL);
const vault = new FsVaultAdapter(config.KB_VAULT);
const index = await createSearchIndex({ config, vault, log: logger });
const ledger = new JsonlSpendLedger(
  join(config.KB_CHAT_STATE_DIR, 'spend.jsonl'),
);
const catalog = new CatalogRegistry(vault);
await catalog.load();
const agent = createResearchAgent({
  catalog,
  index,
  vault,
  ledger,
  budgets: budgetsFromConfig(config),
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
// The owner's settings already exist, so the first-run wizard stays away from the other specs;
// the wizard's spec fakes a first run in the browser.
const settingsStore = new JsonSettingsStore(
  join(config.KB_CHAT_STATE_DIR, 'settings'),
);
await settingsStore.write(OWNER, { version: 1 });
const ai = await createAiProviders({
  config,
  principal: OWNER,
  store: settingsStore,
  // No claude or codex on this PATH: subscriptions show as not installed.
  env: { PATH: '/usr/bin:/bin' },
  fetch: fakeProviderFetch,
  tools: agent.toolsFor,
  perTokenRunner: agent.perTokenRunner,
  systemPrompt: agent.systemPrompt,
  subAgentPrompt: agent.subAgentPrompt,
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
// Codes and notices land in memory; the specs read them under /api/e2e/outbox (KBC-014).
const outbox = new MemoryOutbox();
const access = {
  codes: new MemoryDocumentStore(),
  requests: new MemoryDocumentStore(),
  delivery: { email: outbox, sms: null },
};
const app = await buildApp({
  config,
  auth,
  access,
  vault,
  index,
  logger,
  catalog,
  agent,
  ai,
  ledger,
  usage,
  conversations,
});
identity.register(app);
registerOutbox(app, outbox);
await app.listen({ host: '127.0.0.1', port: config.PORT });
