import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FAKES_DIR, FIXTURE_VAULT } from '../../../test/fixture-paths.js';
import { FsVaultAdapter } from '../../adapters/fs-vault-adapter.js';
import { buildApp } from '../../app.js';
import { loadConfig } from '../../config.js';
import { createSearchIndex } from '../../search-index-factory.js';

describe('health when QMD cannot start', () => {
  it('reports degraded and serves search through the kb CLI', async () => {
    const logs: string[] = [];
    const config = loadConfig({
      KB_VAULT: FIXTURE_VAULT,
      QMD_BIN: '/nonexistent/qmd',
      KB_BIN: join(FAKES_DIR, 'fake-kb.mjs'),
      LOG_LEVEL: 'silent',
    });
    const vault = new FsVaultAdapter(config.KB_VAULT);
    const index = await createSearchIndex({
      config,
      vault,
      log: (message) => logs.push(message),
    });
    const app = await buildApp({ config, vault, index });
    const headers = { host: 'localhost' };

    const health = await app.inject({ method: 'GET', url: '/health', headers });
    const search = await app.inject({
      method: 'POST',
      url: '/api/v1/topics/hermetismo/searches',
      headers,
      payload: { q: 'ritmo' },
    });
    await app.close();

    expect(health.json()).toMatchObject({
      status: 'degraded',
      search: 'degraded',
    });
    expect(search.json().items[0].id).toBe('raw/articles/a-lei-do-ritmo.md');
    expect(logs[0]).toMatch(/using kb search/);
  });
});
