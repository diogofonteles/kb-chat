import { readFile } from 'node:fs/promises';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { closeApp } from '../test/ai-app-harness.js';
import { FIXTURE_VAULT } from '../test/fixture-paths.js';
import { startMedia } from '../test/media-harness.js';
import { FsVaultAdapter } from './adapters/fs-vault-adapter.js';
import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { createLogger } from './logger.js';
import { createSearchIndex } from './search-index-factory.js';

let app: FastifyInstance;

beforeAll(async () => {
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

const label = (route: { method: unknown; url: string }) =>
  `${String(route.method)} ${route.url}`;

describe('route access (NFR-2, AC-6)', () => {
  it('every /api/v1 route declares its access', () => {
    const api = app.routeAccess.filter((r) => r.url.startsWith('/api/v1/'));

    expect(api.length).toBeGreaterThan(20);
    expect(api.filter((r) => r.access === undefined).map(label)).toEqual([]);
  });

  it('only sign-in, health and the token-authenticated MCP turns are public', () => {
    const open = app.routeAccess
      .filter((r) => r.access?.public)
      .map(label)
      .sort();

    expect(open).toEqual(
      [
        'GET /api/v1/auth/config',
        'GET /health',
        'HEAD /api/v1/auth/config',
        'HEAD /health',
        'POST /api/v1/auth/google',
        'POST /api/v1/auth/logout',
        // KBC-014 (ADR 0011): asking for access and signing in with a one-time code.
        'POST /api/v1/access-requests/signup',
        'POST /api/v1/access-requests/signup/verify',
        'POST /api/v1/access-requests/google',
        'POST /api/v1/auth/code',
        'POST /api/v1/auth/code/verify',
        'GET,HEAD,TRACE,DELETE,OPTIONS,PATCH,PUT,POST /mcp/turn',
        'GET,HEAD,TRACE,DELETE,OPTIONS,PATCH,PUT,POST /mcp/turns/:token',
      ].sort(),
    );
  });

  it('every collection route checks the collection', () => {
    const collectionRoutes = app.routeAccess.filter((r) =>
      r.url.includes(':topic'),
    );

    expect(collectionRoutes.length).toBeGreaterThan(5);
    expect(
      collectionRoutes
        .filter((r) => r.access?.public || r.access?.topicParam !== 'topic')
        .map(label),
    ).toEqual([]);
  });

  it('feature routes declare their feature and people routes the master role', () => {
    const find = (method: string, url: string) =>
      app.routeAccess.find((r) => r.method === method && r.url === url)?.access;

    expect(find('POST', '/api/v1/topics/:topic/searches')).toMatchObject({
      feature: 'search',
    });
    expect(find('GET', '/api/v1/topics/:topic/facets')).toMatchObject({
      feature: 'search',
    });
    expect(find('POST', '/api/v1/topics/:topic/research')).toMatchObject({
      feature: 'research',
    });
    // KBC-049 BR-3: registering an author is part of sending content there.
    expect(find('POST', '/api/v1/topics/:topic/authors')).toEqual({
      feature: 'media-upload',
      topicParam: 'topic',
    });
    expect(find('GET', '/api/v1/topics/:topic/authors')).toEqual({
      topicParam: 'topic',
    });
    expect(find('GET', '/api/v1/ai/providers')).toMatchObject({
      feature: 'own-ai-settings',
    });
    for (const method of ['GET', 'POST'])
      expect(find(method, '/api/v1/people')).toEqual({ master: true });
    for (const method of ['PATCH', 'DELETE'])
      expect(find(method, '/api/v1/people/:id')).toEqual({ master: true });
    expect(find('GET', '/api/v1/access-requests')).toEqual({ master: true });
    for (const action of ['approve', 'refuse'])
      expect(find('POST', `/api/v1/access-requests/:id/${action}`)).toEqual({
        master: true,
      });
  });

  it('refuses to register an /api/v1 route without an access declaration', async () => {
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
    const other = await buildApp({ config, vault, index });

    expect(() => other.get('/api/v1/unguarded', async () => 'ok')).toThrow(
      /declares no config.access/,
    );
    await other.close();
  });
});

// Media routes exist only in an app built with a media library.
describe('voice-profile routes', () => {
  afterEach(closeApp);

  it('need the master role and refuse while acting (ADR 0032)', async () => {
    const { started } = await startMedia();
    const access = {
      feature: ['media', 'media-voice-profiles'],
      master: true,
      notWhileActing: true,
    };
    const inCollection = { ...access, topicParam: 'topic' };
    const find = (method: string, url: string) =>
      started.app.routeAccess.find((r) => r.method === method && r.url === url)
        ?.access;

    for (const [method, url] of [
      ['GET', '/api/v1/topics/:topic/voice-profiles'],
      ['POST', '/api/v1/topics/:topic/voice-profiles'],
      ['GET', '/api/v1/topics/:topic/speakers/:speakerId/named-voices'],
    ] as const)
      expect(find(method, url), `${method} ${url}`).toEqual(inCollection);
    for (const [method, url] of [
      ['DELETE', '/api/v1/voice-profiles/:id'],
      ['POST', '/api/v1/voice-profiles/:id/recalculate'],
      ['GET', '/api/v1/voice-profiles/report'],
      ['GET', '/api/v1/voice-consents/:id/evidence'],
    ] as const)
      expect(find(method, url), `${method} ${url}`).toEqual(access);
  });
});

describe('the E2E identity stays in the E2E server', () => {
  it('main never imports the test identity', async () => {
    const main = await readFile(new URL('./main.ts', import.meta.url), 'utf8');
    expect(main).not.toMatch(/test-identity|outbox|\/e2e\//);
    expect(main).toContain('createGoogleVerifier(config.GOOGLE_CLIENT_ID)');
  });
});
