import { join } from 'node:path';
import { FsVaultAdapter } from './adapters/fs-vault-adapter.js';
import { USAGE_RETENTION_DAYS, buildApp } from './app.js';
import { loadConfig } from './config.js';
import { createLogger } from './logger.js';
import { JsonlSpendLedger } from './adapters/jsonl-spend-ledger.js';
import { JsonlUsageLog } from './adapters/jsonl-usage-log.js';
import { createLlm } from './llm-factory.js';
import { createSearchIndex } from './search-index-factory.js';

const config = loadConfig();
const logger = createLogger(config.LOG_LEVEL);
const vault = new FsVaultAdapter(config.KB_VAULT);
const index = await createSearchIndex({ config, vault, log: logger });
const llm = await createLlm(config);
const ledger = new JsonlSpendLedger(
  join(config.KB_CHAT_STATE_DIR, 'spend.jsonl'),
);
const usage = new JsonlUsageLog(join(config.KB_CHAT_STATE_DIR, 'events.jsonl'));
// Retention of the local usage log (KBC-006 BR-3).
await usage.prune(new Date(Date.now() - USAGE_RETENTION_DAYS * 86_400_000));
const app = await buildApp({
  config,
  vault,
  index,
  logger,
  llm,
  ledger,
  usage,
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
