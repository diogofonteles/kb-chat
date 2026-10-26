import { CSRF_HEADER, CSRF_HEADER_VALUE } from '@kb-chat/contracts';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { createTestAuth } from '../test/auth-factories.js';
import { FIXTURE_VAULT } from '../test/fixture-paths.js';
import { FsVaultAdapter } from './adapters/fs-vault-adapter.js';
import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { createLogger } from './logger.js';
import { createSearchIndex } from './search-index-factory.js';

const PROXY = '172.18.0.3';
const PUBLIC_SOCKET = '198.51.100.7';

let app: FastifyInstance | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

/** The API with one sign-in attempt per minute per client: a 429 shows who "the client" is. */
async function appWith(trustProxy?: string): Promise<FastifyInstance> {
  const config = loadConfig({
    KB_VAULT: FIXTURE_VAULT,
    KB_CHAT_SEARCH: 'fixture',
    LOG_LEVEL: 'silent',
    AUTH_RATE_LIMIT: '1',
    ...(trustProxy ? { TRUST_PROXY: trustProxy } : {}),
  });
  const vault = new FsVaultAdapter(config.KB_VAULT);
  const index = await createSearchIndex({
    config,
    vault,
    log: createLogger('silent'),
  });
  return buildApp({ config, vault, index, auth: createTestAuth() });
}

/** One sign-in attempt from `socket`, claiming `forwardedFor`; returns the status code. */
async function attempt(
  instance: FastifyInstance,
  socket: string,
  forwardedFor: string,
): Promise<number> {
  const response = await instance.inject({
    method: 'POST',
    url: '/api/v1/auth/google',
    remoteAddress: socket,
    headers: {
      host: 'localhost',
      [CSRF_HEADER]: CSRF_HEADER_VALUE,
      'x-forwarded-for': forwardedFor,
    },
    payload: { credential: 'not-a-real-google-token' },
  });
  return response.statusCode;
}

describe('TRUST_PROXY (ADR 0010, ND-21)', () => {
  it('behind the proxy, limits each forwarded client on its own', async () => {
    app = await appWith('uniquelocal');
    expect(await attempt(app, PROXY, '203.0.113.9')).not.toBe(429);
    expect(await attempt(app, PROXY, '203.0.113.10')).not.toBe(429);
    expect(await attempt(app, PROXY, '203.0.113.9')).toBe(429);
  });

  it('does not believe X-Forwarded-For from a socket that is not a trusted proxy', async () => {
    app = await appWith('uniquelocal');
    expect(await attempt(app, PUBLIC_SOCKET, '203.0.113.9')).not.toBe(429);
    expect(await attempt(app, PUBLIC_SOCKET, '203.0.113.10')).toBe(429);
  });

  it('ignores X-Forwarded-For entirely when unset (local use)', async () => {
    app = await appWith();
    expect(await attempt(app, PROXY, '203.0.113.9')).not.toBe(429);
    expect(await attempt(app, PROXY, '203.0.113.10')).toBe(429);
  });
});
