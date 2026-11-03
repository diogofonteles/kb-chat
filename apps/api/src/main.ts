import { join } from 'node:path';
import { FsVaultAdapter } from './adapters/fs-vault-adapter.js';
import { OWNER, buildApp } from './app.js';
import { createMedia } from './media-factory.js';
import { applyUsageRetention } from './modules/usage/index.js';
import {
  assertAiConfigured,
  assertDeliveryConfigured,
  assertSignInConfigured,
  isHosted,
  loadConfig,
} from './config.js';
import { SealedSettingsStore } from './adapters/sealed-settings-store.js';
import { SecretBox, deriveKey, loadSecretsKey } from './adapters/secret-box.js';
import { createHouseAi } from './house-ai-factory.js';
import { JsonDocumentStore } from './adapters/json-document-store.js';
import { createDelivery } from './delivery-factory.js';
import { JsonPeopleStore } from './adapters/json-people-store.js';
import { FsSessionStore } from './adapters/fs-session-store.js';
import { createGoogleVerifier } from './adapters/google-id-token-verifier.js';
import {
  ActAsService,
  PeopleService,
  SessionService,
} from './modules/auth/index.js';
import { FsActAsAudit } from './adapters/fs-act-as-audit.js';
import { createLogger } from './logger.js';
import { JsonlSpendLedger } from './adapters/jsonl-spend-ledger.js';
import { JsonlUsageLog } from './adapters/jsonl-usage-log.js';
import { FsConversationStore } from './adapters/fs-conversation-store.js';
import { JsonSettingsStore } from './adapters/json-settings-store.js';
import { createAiProviders } from './providers/create-ai-providers.js';
import { AuthorDirectory, AuthorsService } from './modules/authors/index.js';
import { CatalogRegistry } from './modules/catalog/index.js';
import {
  CollectionRegistry,
  CollectionsVault,
} from './modules/topics/index.js';
import {
  budgetsFromConfig,
  createResearchAgent,
} from './research-agent-factory.js';
import { createSearchIndex } from './search-index-factory.js';

const config = loadConfig();
assertSignInConfigured(config);
assertDeliveryConfigured(config);
assertAiConfigured(config);
const logger = createLogger(config.LOG_LEVEL);
// Every provider key on disk is sealed with this key (ADR 0017).
const secretsKey = await loadSecretsKey({
  configured: config.KB_CHAT_SECRETS_KEY,
  stateDir: config.KB_CHAT_STATE_DIR,
  hosted: isHosted(config),
});
const sealer = new SecretBox(secretsKey);
// The vault plus the collections created on the screen (ADR 0028); the vault stays read-only.
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
// One set of research tools for the in-API loop and the subscription CLIs (ADR 0006/0007).
const agent = createResearchAgent({
  catalog,
  index,
  vault,
  ledger,
  budgets: budgetsFromConfig(config),
  mainAuthorOf: (topic) => authors.mainOf(topic)?.name ?? null,
});
// Sign-in with Google and who may use what (KBC-010, ADR 0008).
const people = new PeopleService({
  store: new JsonPeopleStore(join(config.KB_CHAT_STATE_DIR, 'people.json')),
  ownerEmail: config.KB_CHAT_OWNER_EMAIL,
});
const sessions = new SessionService({
  store: new FsSessionStore(join(config.KB_CHAT_STATE_DIR, 'sessions')),
});
const auth = {
  people,
  sessions,
  verifier: createGoogleVerifier(config.GOOGLE_CLIENT_ID),
  // Masters acting as a person, audited on disk (KBC-060, ADR 0027).
  actAs: new ActAsService({
    sessions,
    people,
    audit: new FsActAsAudit(join(config.KB_CHAT_STATE_DIR, 'audit')),
  }),
};
// The app's own AI, configured by a master in the UI (KBC-022, ADR 0016).
const house = await createHouseAi({
  stateDir: config.KB_CHAT_STATE_DIR,
  sealer,
  webOrigin: config.WEB_ORIGIN,
  warn: (message) => logger.warn(message),
});
// Settings first, then the environment, resolved per request (KBC-007, ADR 0007).
const ai = await createAiProviders({
  config,
  principal: OWNER,
  store: new SealedSettingsStore({
    store: new JsonSettingsStore(join(config.KB_CHAT_STATE_DIR, 'settings')),
    sealer,
    warn: (message) => logger.warn(message),
  }),
  env: process.env,
  warn: (message) => logger.warn(message),
  tools: agent.toolsFor,
  perTokenRunner: agent.perTokenRunner,
  systemPrompt: agent.systemPrompt,
  house,
  personOf: (principal) => auth.people.cachedByPrincipal(principal),
  ledger,
});
const usage = new JsonlUsageLog(join(config.KB_CHAT_STATE_DIR, 'events.jsonl'));
await applyUsageRetention(usage, logger);
const conversations = new FsConversationStore({
  dir: join(config.KB_CHAT_STATE_DIR, 'conversations'),
  log: logger,
});
// Access requests and one-time codes by email or SMS (KBC-014, ADR 0011).
const access = {
  codes: new JsonDocumentStore(join(config.KB_CHAT_STATE_DIR, 'codes.json')),
  requests: new JsonDocumentStore(
    join(config.KB_CHAT_STATE_DIR, 'access-requests.json'),
  ),
  delivery: createDelivery(config, logger),
};
// KBC-034 FR-1: with KB_CHAT_MEDIA=on, a media library that cannot open stops the start.
const media = await createMedia(config, {
  tokenKey: deriveKey(secretsKey, 'transcriber-tokens'),
});

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
  house,
  media,
  collections,
  authorDirectory,
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
