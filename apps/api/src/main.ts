import { join } from 'node:path';
import { FsVaultAdapter } from './adapters/fs-vault-adapter.js';
import { buildApp } from './app.js';
import { applyUsageRetention } from './modules/usage/index.js';
import { loadConfig } from './config.js';
import { createLogger } from './logger.js';
import { JsonlSpendLedger } from './adapters/jsonl-spend-ledger.js';
import { JsonlUsageLog } from './adapters/jsonl-usage-log.js';
import { FsConversationStore } from './adapters/fs-conversation-store.js';
import { createLlm } from './llm-factory.js';
import { createSearchIndex } from './search-index-factory.js';

const config = loadConfig();
const logger = createLogger(config.LOG_LEVEL);
const vault = new FsVaultAdapter(config.KB_VAULT);
const index = await createSearchIndex({ config, vault, log: logger });
const llm = createLlm(config);
const ledger = new JsonlSpendLedger(
  join(config.KB_CHAT_STATE_DIR, 'spend.jsonl'),
);
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
  llm,
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
