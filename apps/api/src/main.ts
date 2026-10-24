import { join } from 'node:path';
import { FsVaultAdapter } from './adapters/fs-vault-adapter.js';
import { OWNER, buildApp } from './app.js';
import { applyUsageRetention } from './modules/usage/index.js';
import { loadConfig } from './config.js';
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
const app = await buildApp({
  config,
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

await app.listen({ host: '127.0.0.1', port: config.PORT });
app.log.info(
  { vault: config.KB_VAULT, search: index.status() },
  'kb-chat api ready',
);
