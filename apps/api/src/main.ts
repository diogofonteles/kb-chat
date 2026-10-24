import { FsVaultAdapter } from './adapters/fs-vault-adapter.js';
import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { createSearchIndex } from './search-index-factory.js';

const config = loadConfig();
const vault = new FsVaultAdapter(config.KB_VAULT);
const index = await createSearchIndex({
  config,
  vault,
  log: (message) => process.stderr.write(`${message}\n`),
});
const app = await buildApp({ config, vault, index });

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
