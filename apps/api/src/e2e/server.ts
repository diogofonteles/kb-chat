import { fileURLToPath } from 'node:url';
import { FsVaultAdapter } from '../adapters/fs-vault-adapter.js';
import { buildApp } from '../app.js';
import { loadConfig } from '../config.js';
import { createLogger } from '../logger.js';
import { createSearchIndex } from '../search-index-factory.js';

// E2E server: the fixture vault and the in-process index, no QMD or models.
const config = loadConfig({
  ...process.env,
  KB_VAULT: fileURLToPath(
    new URL('../../test/fixtures/vault', import.meta.url),
  ),
  KB_CHAT_SEARCH: 'fixture',
  LOG_LEVEL: 'warn',
});
const logger = createLogger(config.LOG_LEVEL);
const vault = new FsVaultAdapter(config.KB_VAULT);
const index = await createSearchIndex({ config, vault, log: logger });
const app = await buildApp({ config, vault, index, logger });
await app.listen({ host: '127.0.0.1', port: config.PORT });
