import { signedInApp } from '../test/auth-factories.js';
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FIXTURE_VAULT } from '../test/fixture-paths.js';
import { FsVaultAdapter } from './adapters/fs-vault-adapter.js';
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

const HOST: Record<string, string> = { host: 'localhost:3000' };
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
  app = await signedInApp(HOST)({ config, vault, index });
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
        {
          slug: 'alquimia',
          title: 'Alquimia Prática',
          documentCount: 1,
          trackCount: 0,
          parent: null,
          description: '',
          canOpen: true,
          canRename: true,
          mainAuthor: null,
        },
        {
          slug: 'hermetismo',
          title: 'Hermetismo',
          documentCount: 22,
          trackCount: 0,
          parent: null,
          description: '',
          canOpen: true,
          canRename: true,
          // KBC-049 BR-4: the documents marked as the Mestre's make him the main author.
          mainAuthor: { slug: 'mestre-laercio', name: 'Mestre Laércio' },
        },
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
      catalog: { documents: 23 },
    });
  });
});

describe('vault safety', () => {
  it('leaves the vault byte for byte unchanged', async () => {
    expect(await hashTree(FIXTURE_VAULT)).toBe(hashBefore);
  });
});

describe('facet filters (KBC-002)', () => {
  const searchWith = (payload: object) =>
    app.inject({
      method: 'POST',
      url: '/api/v1/topics/hermetismo/searches',
      headers: HOST,
      payload,
    });

  it('groups copies into one card and hides off-topic by default', async () => {
    const body = (await searchWith({ q: 'sétupla', mode: 'semantic' })).json();
    expect(body.items.map((i: { id: string }) => i.id)).toEqual([
      'raw/articles/a-natureza-s-tupla-2.md',
    ]);
    expect(body.items[0].copies).toEqual([
      {
        id: 'raw/articles/a-natureza-s-tupla-5.md',
        title: 'A Natureza Sétupla',
      },
    ]);
    expect(body.hiddenOffTopic).toBe(1);
  });

  it('filters by subject and text type and returns disjunctive counts', async () => {
    const body = (
      await searchWith({
        q: 'natureza',
        mode: 'semantic',
        filters: { concepts: ['Cabala'], genres: ['talk_or_interview'] },
      })
    ).json();
    expect(body.items.map((i: { title: string }) => i.title)).toEqual([
      'A Natureza Sétupla',
      'A Árvore da Vida',
    ]);
    expect(body.facets.concepts).toContainEqual({ value: 'Cabala', count: 2 });
  });

  it('serves collection-wide facet counts', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/topics/hermetismo/facets',
      headers: HOST,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().concepts.slice(0, 3)).toEqual([
      { value: 'Hermetismo e Filosofia Hermética', count: 13 },
      { value: 'Cabala', count: 2 },
      { value: 'Cosmologia Espiritual e Metafísica', count: 2 },
    ]);
  });

  it('rejects a filter field outside the allowlist', async () => {
    const response = await searchWith({ q: 'x', filters: { path: '/etc' } });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('VALIDATION_FAILED');
  });
});

describe('document panel data (KBC-003)', () => {
  const doc = (id: string, suffix = '') =>
    app.inject({
      method: 'GET',
      url: `/api/v1/topics/hermetismo/documents/${encodeURIComponent(id)}${suffix}`,
      headers: HOST,
    });

  it('returns see-also groups, origin and the Obsidian link of a source', async () => {
    const body = (await doc('raw/articles/arvore-da-vida.md')).json();
    expect(body.seeAlso.exampleOf).toMatchObject({
      items: [{ id: 'wiki/concepts/Cabala.md', title: 'Cabala' }],
      total: 1,
    });
    expect(body.seeAlso.related).toEqual({ items: [], total: 0 });
    expect(body.origin).toBe('audio');
    expect(body.obsidianUrl).toBe(
      'obsidian://open?vault=vault&file=hermetismo%2Fraw%2Farticles%2Farvore-da-vida',
    );
  });

  it('lists the documents pointing to a concept article, with its criterion', async () => {
    const body = (await doc('wiki/concepts/Cabala.md')).json();
    expect(body.criterion).toMatch(/Árvore da Vida/);
    expect(
      body.seeAlso.examples.items.map((r: { id: string }) => r.id),
    ).toEqual(['raw/articles/arvore-da-vida.md']);
    expect(body.seeAlso.relatedFrom.total).toBe(1);
  });

  it('pages a see-also group and validates the group name', async () => {
    const page = (
      await doc(
        'wiki/concepts/Cabala.md',
        '/relations/examples?offset=0&limit=1',
      )
    ).json();
    expect(page).toMatchObject({
      items: [
        {
          id: 'raw/articles/arvore-da-vida.md',
          title: 'A Árvore da Vida',
          genre: 'talk_or_interview',
        },
      ],
      total: 1,
      nextOffset: null,
    });
    const bad = await doc('wiki/concepts/Cabala.md', '/relations/everything');
    expect(bad.statusCode).toBe(400);
  });
});

describe('see-also paging, copies and long ids (KBC-003 review)', () => {
  const get = (url: string) =>
    app.inject({ method: 'GET', url, headers: HOST });
  const doc = (id: string) =>
    `/api/v1/topics/hermetismo/documents/${encodeURIComponent(id)}`;

  it('previews 5 references with the total and their facets (BR-3, FR-3)', async () => {
    const body = (await get(doc('wiki/concepts/Ritmo.md'))).json();
    expect(body.seeAlso.examples.total).toBe(12);
    expect(body.seeAlso.examples.items).toHaveLength(5);
    expect(body.seeAlso.examples.items[0]).toMatchObject({
      genre: 'article_or_essay',
      depth: 1,
      relevance: 'adjacent',
    });
  });

  it('pages a group with nextOffset until the end', async () => {
    const first = (
      await get(
        `${doc('wiki/concepts/Ritmo.md')}/relations/examples?offset=5&limit=5`,
      )
    ).json();
    expect(first.items).toHaveLength(5);
    expect(first.nextOffset).toBe(10);
    const last = (
      await get(
        `${doc('wiki/concepts/Ritmo.md')}/relations/examples?offset=10&limit=5`,
      )
    ).json();
    expect(last.items).toHaveLength(2);
    expect(last.nextOffset).toBeNull();
  });

  it('collapses copies and matches concept names case-insensitively', async () => {
    const body = (await get(doc('wiki/concepts/Cabala.md'))).json();
    expect(body.seeAlso.relatedFrom.total).toBe(1);
  });

  it('answers 404 and 400 on the relations route', async () => {
    expect(
      (await get(`${doc('raw/articles/nope.md')}/relations/examples`))
        .statusCode,
    ).toBe(404);
    expect((await get(`${doc('../x.md')}/relations/examples`)).statusCode).toBe(
      400,
    );
  });

  it('opens documents whose ids are longer than 100 characters', async () => {
    const id =
      'raw/articles/um-titulo-muito-longo-de-apostila-convertida-sobre-os-principios-hermeticos-e-a-tradicao-egipcia-volume-dois.md';
    const response = await get(doc(id));
    expect(response.statusCode).toBe(200);
    expect(response.json().title).toBe('Um Título Muito Longo');
  });
});
