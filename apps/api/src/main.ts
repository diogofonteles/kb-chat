import { join } from 'node:path';
import { FsVaultAdapter } from './adapters/fs-vault-adapter.js';
import { OWNER, buildApp } from './app.js';
import { applyUsageRetention } from './modules/usage/index.js';
import { assertSignInConfigured, loadConfig } from './config.js';
import { JsonPeopleStore } from './adapters/json-people-store.js';
import { FsSessionStore } from './adapters/fs-session-store.js';
import { createGoogleVerifier } from './adapters/google-id-token-verifier.js';
import { PeopleService, SessionService } from './modules/auth/index.js';
import { createLogger } from './logger.js';
import { JsonlSpendLedger } from './adapters/jsonl-spend-ledger.js';
import { JsonlUsageLog } from './adapters/jsonl-usage-log.js';
import { FsConversationStore } from './adapters/fs-conversation-store.js';
import { JsonSettingsStore } from './adapters/json-settings-store.js';
import { createAiProviders } from './providers/create-ai-providers.js';
import { CatalogRegistry } from './modules/catalog/index.js';
import { createResearchAgent } from './research-agent-factory.js';
import { createSearchIndex } from './search-index-factory.js';

const config = loadConfig();
assertSignInConfigured(config);
const logger = createLogger(config.LOG_LEVEL);
const vault = new FsVaultAdapter(config.KB_VAULT);
const index = await createSearchIndex({ config, vault, log: logger });
const ledger = new JsonlSpendLedger(
  join(config.KB_CHAT_STATE_DIR, 'spend.jsonl'),
);
const catalog = new CatalogRegistry(vault);
await catalog.load();
// One set of research tools for the in-API loop and the subscription CLIs (ADR 0006/0007).
const agent = createResearchAgent({ catalog, index, vault, ledger });
// Settings first, then the environment, resolved per request (KBC-007, ADR 0007).
const ai = await createAiProviders({
  config,
  principal: OWNER,
  store: new JsonSettingsStore(join(config.KB_CHAT_STATE_DIR, 'settings')),
  env: process.env,
  warn: (message) => logger.warn(message),
  tools: agent.toolsFor,
  perTokenRunner: agent.perTokenRunner,
  systemPrompt: agent.systemPrompt,
});
const usage = new JsonlUsageLog(join(config.KB_CHAT_STATE_DIR, 'events.jsonl'));
await applyUsageRetention(usage, logger);
const conversations = new FsConversationStore({
  dir: join(config.KB_CHAT_STATE_DIR, 'conversations'),
  log: logger,
});
// Sign-in with Google and who may use what (KBC-010, ADR 0008).
const auth = {
  people: new PeopleService({
    store: new JsonPeopleStore(join(config.KB_CHAT_STATE_DIR, 'people.json')),
    ownerEmail: config.KB_CHAT_OWNER_EMAIL,
  }),
  sessions: new SessionService({
    store: new FsSessionStore(join(config.KB_CHAT_STATE_DIR, 'sessions')),
  }),
  verifier: createGoogleVerifier(config.GOOGLE_CLIENT_ID),
};
const app = await buildApp({
  config,
  auth,
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

const shutdown = async (): Promise<void> => {
  await app.close();
  process.exit(0);
};
process.once('SIGTERM', () => void shutdown());
process.once('SIGINT', () => void shutdown());

await app.listen({ host: config.HOST, port: config.PORT });
app.log.info(
  { vault: config.KB_VAULT, search: index.status() },
  'kb-chat api ready',
);

// find_text's folded copy of the start collection takes seconds on a big vault: build it
// now, in the background, so the first answer does not wait for it (KBC-011).
const startTopic =
  ai.settings.snapshot(OWNER)?.preferences.defaultTopic ??
  config.KB_TOPIC ??
  catalog.topics()[0]?.topic.slug;
if (startTopic) {
  const startedAt = performance.now();
  agent.tools.warm(startTopic).then(
    () =>
      app.log.info(
        { topic: startTopic, ms: Math.round(performance.now() - startedAt) },
        'find_text cache ready',
      ),
    (err: unknown) => app.log.warn({ err }, 'find_text cache warm-up failed'),
  );
}
