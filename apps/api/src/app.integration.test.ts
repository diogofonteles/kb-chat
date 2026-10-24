import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FIXTURE_VAULT } from '../test/fixture-paths.js';
import { FsVaultAdapter } from './adapters/fs-vault-adapter.js';
import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { createLogger } from './logger.js';
import { createSearchIndex } from './search-index-factory.js';

async function hashTree(dir: string): Promise<string> {
  const hash = createHash('sha256');
  const files = (await readdir(dir, { recursive: true, withFileTypes: true }))
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name))
    .sort();
  for (const file of files) hash.update(file).update(await readFile(file));
  return hash.digest('hex');
}

const HOST = { host: 'localhost:3000' };
let app: FastifyInstance;
let hashBefore: string;

beforeAll(async () => {
  hashBefore = await hashTree(FIXTURE_VAULT);
  const config = loadConfig({
    KB_VAULT: FIXTURE_VAULT,
    KB_CHAT_SEARCH: 'fixture',
    LOG_LEVEL: 'silent',
  });
  const vault = new FsVaultAdapter(config.KB_VAULT);
  const index = await createSearchIndex({
    config,
    vault,
    log: createLogger('silent'),
  });
  app = await buildApp({ config, vault, index });
});

afterAll(async () => {
  await app.close();
});

describe('GET /api/v1/topics', () => {
  it('lists the vault topics with document counts, skipping quarantine', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/topics',
      headers: HOST,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      items: [
        { slug: 'alquimia', title: 'Alquimia Prática', documentCount: 1 },
        { slug: 'hermetismo', title: 'Hermetismo', documentCount: 5 },
      ],
      defaultSlug: null,
    });
  });
});

describe('POST /api/v1/topics/:topic/searches', () => {
  it('returns hits with display titles, facets and body snippets', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/topics/hermetismo/searches',
      headers: HOST,
      payload: { q: 'natureza sétupla', mode: 'exact' },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.mode).toBe('exact');
    expect(body.items[0]).toMatchObject({
      id: 'raw/articles/a-natureza-s-tupla-2.md',
      title: 'A Natureza Sétupla',
      genre: 'talk_or_interview',
      depth: 1,
      relevance: 'core',
      concepts: ['Cosmologia Espiritual e Metafísica', 'Cabala'],
    });
    expect(body.items[0].snippet).not.toMatch(/title:|type:/);
  });

  it('defaults to the "all" mode', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/topics/hermetismo/searches',
      headers: HOST,
      payload: { q: 'ritmo' },
    });
    expect(response.json().mode).toBe('all');
  });

  it('rejects unknown body fields with VALIDATION_FAILED', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/topics/hermetismo/searches',
      headers: HOST,
      payload: { q: 'ritmo', path: '/etc' },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('VALIDATION_FAILED');
  });

  it('answers 404 TOPIC_NOT_FOUND for an unknown topic', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/topics/nope/searches',
      headers: HOST,
      payload: { q: 'ritmo' },
    });
    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe('TOPIC_NOT_FOUND');
  });
});

describe('GET /api/v1/topics/:topic/documents/:id', () => {
  const url = (id: string): string =>
    `/api/v1/topics/hermetismo/documents/${encodeURIComponent(id)}`;

  it('returns the body without frontmatter', async () => {
    const response = await app.inject({
      method: 'GET',
      url: url('raw/articles/a-lei-do-ritmo.md'),
      headers: HOST,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      title: 'A Lei do Ritmo',
      depth: 2,
      summary: expect.any(String),
    });
    expect(response.json().body).toMatch(/^A LEI DO RITMO/);
  });

  it('refuses a traversal id with 400 without reading it', async () => {
    const response = await app.inject({
      method: 'GET',
      url: url('../../../etc/passwd'),
      headers: HOST,
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('VALIDATION_FAILED');
  });

  it('answers 404 for a quarantined or missing document', async () => {
    const response = await app.inject({
      method: 'GET',
      url: url('raw/_quarantine/articles/escondido.md'),
      headers: HOST,
    });
    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe('DOCUMENT_NOT_FOUND');
  });
});

describe('host guard and CORS', () => {
  it('refuses a foreign Host header with 403', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/topics',
      headers: { host: 'evil.example' },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe('FORBIDDEN_HOST');
  });

  it('allows only the configured web origin', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/topics',
      headers: { ...HOST, origin: 'http://localhost:4200' },
    });
    expect(response.headers['access-control-allow-origin']).toBe(
      'http://localhost:4200',
    );
    const foreign = await app.inject({
      method: 'GET',
      url: '/api/v1/topics',
      headers: { ...HOST, origin: 'http://evil.example' },
    });
    expect(foreign.headers['access-control-allow-origin']).toBeUndefined();
  });
});

describe('GET /health', () => {
  it('reports the catalog size and search status', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/health',
      headers: HOST,
    });
    expect(response.json()).toEqual({
      status: 'ok',
      search: 'ok',
      catalog: { documents: 6 },
    });
  });
});

describe('vault safety', () => {
  it('leaves the vault byte for byte unchanged', async () => {
    expect(await hashTree(FIXTURE_VAULT)).toBe(hashBefore);
  });
});
