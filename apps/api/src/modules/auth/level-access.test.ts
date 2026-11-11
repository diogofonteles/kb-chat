import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { registerErrorHandler } from '../../error-handler.js';
import { assertTracksOpen, type LevelHooks } from './access.js';
import type { StoredPerson } from './person.js';

const ana: StoredPerson = {
  id: '0f0e0d0c-0b0a-4908-8706-050403020100',
  sub: null,
  email: 'ana@example.com',
  name: 'Ana',
  picture: null,
  role: 'member',
  topics: ['hermetismo'],
  features: ['research'],
  invitedBy: 'owner@example.com',
  createdAt: '2026-11-10T00:00:00.000Z',
  lastLoginAt: null,
};

let app: FastifyInstance | null = null;
afterEach(async () => {
  await app?.close();
  app = null;
});

/** A route that asks whether the media of `hermetismo` is open, with or without the hooks. */
async function appWith(hooks?: LevelHooks): Promise<FastifyInstance> {
  const built = Fastify();
  registerErrorHandler(built);
  if (hooks) built.decorate('levelHooks', hooks);
  built.decorateRequest('viewer', null);
  built.addHook('onRequest', async (request) => {
    request.viewer = { person: ana, principal: 'ana', isOwner: false };
  });
  built.get('/media', async (request) => {
    assertTracksOpen(request, 'hermetismo');
    return { ok: true };
  });
  await built.ready();
  app = built;
  return built;
}

const closed: LevelHooks = {
  codesOf: () => ({}),
  tracksClosedByLevels: () => true,
};

describe('Media and the levels (KBC-103 BR-10, review round 2; research opened by KBC-104)', () => {
  it('answers LEVELS_PENDING while levels hold the collection', async () => {
    const reply = await (await appWith(closed)).inject('/media');
    expect(reply.statusCode).toBe(409);
    expect(reply.json().error.code).toBe('LEVELS_PENDING');
  });

  it('fails closed, never open, when the level hooks are not registered', async () => {
    const reply = await (await appWith()).inject('/media');
    expect(reply.statusCode).toBe(500);
  });
});
