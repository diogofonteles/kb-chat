import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { FIXTURE_VAULT } from '../test/fixture-paths.js';
import { FsVaultAdapter } from './adapters/fs-vault-adapter.js';
import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { createLogger } from './logger.js';
import type { IndexQuery, SearchIndexPort } from './ports/search-index.js';
import { createSearchIndex } from './search-index-factory.js';

const HOST = { host: 'localhost' };
let app: FastifyInstance | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

async function start(
  env: Record<string, string> = {},
  index?: SearchIndexPort,
): Promise<FastifyInstance> {
  const config = loadConfig({
    KB_VAULT: FIXTURE_VAULT,
    KB_CHAT_SEARCH: 'fixture',
    LOG_LEVEL: 'silent',
    ...env,
  });
  const vault = new FsVaultAdapter(config.KB_VAULT);
  const searchIndex =
    index ??
    (await createSearchIndex({ config, vault, log: createLogger('silent') }));
  app = await buildApp({
    config,
    vault,
    index: searchIndex,
    logger: createLogger('silent'),
  });
  return app;
}

class RecordingIndex implements SearchIndexPort {
  readonly queries: IndexQuery[] = [];
  constructor(private readonly failWith?: Error) {}
  status(): 'ok' {
    return 'ok';
  }
  async search(query: IndexQuery) {
    this.queries.push(query);
    if (this.failWith) throw this.failWith;
    return [];
  }
  async close(): Promise<void> {
    // nothing
  }
}

const search = (server: FastifyInstance, payload: object) =>
  server.inject({
    method: 'POST',
    url: '/api/v1/topics/hermetismo/searches',
    headers: HOST,
    payload,
  });

describe('search request handling', () => {
  it('collapses line breaks so QMD never reads a structured query (QA-01)', async () => {
    const index = new RecordingIndex();
    const server = await start({}, index);
    const response = await search(server, {
      q: 'lei do\nritmo\t  hermético',
      mode: 'all',
    });
    expect(response.statusCode).toBe(200);
    expect(index.queries[0]?.q).toBe('lei do ritmo hermético');
  });

  it('asks the index for enough candidates and reports the real total', async () => {
    const index = new RecordingIndex();
    const server = await start({}, index);
    await search(server, { q: 'ritmo', limit: 1 });
    expect(index.queries[0]?.limit).toBe(60);
    await search(server, { q: 'ritmo', filters: { genres: ['paper'] } });
    expect(index.queries[1]?.limit).toBe(200);
    const fixture = await start();
    const body = (
      await search(fixture, { q: 'natureza', mode: 'semantic', limit: 1 })
    ).json();
    expect(body.items).toHaveLength(1);
    expect(body.total).toBe(3);
    expect(body.nextOffset).toBe(1);
    expect(body.capped).toBe(false);
  });

  it('never sends internal details on a 5xx (ND-25)', async () => {
    const server = await start(
      {},
      new RecordingIndex(new Error('spawn /secret/path/kb ENOENT')),
    );
    const response = await search(server, { q: 'ritmo' });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({
      error: {
        code: 'SEARCH_UNAVAILABLE',
        message: 'Search index unavailable',
      },
    });
    expect(response.body).not.toContain('/secret/path');
  });

  it('rate-limits searches per client with the RATE_LIMITED code (ND-22)', async () => {
    const server = await start(
      { SEARCH_RATE_LIMIT: '2' },
      new RecordingIndex(),
    );
    await search(server, { q: 'a b c' });
    await search(server, { q: 'a b c' });
    const third = await search(server, { q: 'a b c' });
    expect(third.statusCode).toBe(429);
    expect(third.json().error.code).toBe('RATE_LIMITED');
  });
});

describe('topics and routing', () => {
  it('exposes KB_TOPIC as the default topic when it exists', async () => {
    const server = await start({ KB_TOPIC: 'alquimia' });
    const body = (
      await server.inject({
        method: 'GET',
        url: '/api/v1/topics',
        headers: HOST,
      })
    ).json();
    expect(body.defaultSlug).toBe('alquimia');
    const unknown = await start({ KB_TOPIC: 'nope' });
    expect(
      (
        await unknown.inject({
          method: 'GET',
          url: '/api/v1/topics',
          headers: HOST,
        })
      ).json().defaultSlug,
    ).toBeNull();
  });

  it('answers unknown routes with the error envelope', async () => {
    const server = await start();
    const response = await server.inject({
      method: 'GET',
      url: '/api/v1/nope',
      headers: HOST,
    });
    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe('NOT_FOUND');
  });
});
