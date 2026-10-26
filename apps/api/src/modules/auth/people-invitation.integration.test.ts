import type { FastifyInstance, InjectOptions } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { CSRF_HEADER, CSRF_HEADER_VALUE } from '@kb-chat/contracts';
import { FIXTURE_VAULT } from '../../../test/fixture-paths.js';
import {
  createTestKeys,
  mintIdToken,
  testVerifier,
  type TestKeys,
} from '../../../test/identity-factories.js';
import { FsVaultAdapter } from '../../adapters/fs-vault-adapter.js';
import { MemoryDocumentStore } from '../../adapters/memory-document-store.js';
import { MemoryOutbox } from '../../adapters/memory-outbox.js';
import { MemoryPeopleStore } from '../../adapters/memory-people-store.js';
import { MemorySessionStore } from '../../adapters/memory-session-store.js';
import type { EmailSenderPort } from '../../ports/email-sender.js';
import { buildApp } from '../../app.js';
import { loadConfig } from '../../config.js';
import { createLogger } from '../../logger.js';
import { createSearchIndex } from '../../search-index-factory.js';
import { PeopleService, SessionService } from './index.js';

const OWNER_EMAIL = 'owner@example.com';
const ORIGIN = 'http://localhost:4200';
const LOCAL = { host: 'localhost:3000', [CSRF_HEADER]: CSRF_HEADER_VALUE };

interface Started {
  readonly app: FastifyInstance;
  readonly keys: TestKeys;
  readonly outbox: MemoryOutbox;
}

let current: FastifyInstance | null = null;
afterEach(async () => {
  await current?.close();
  current = null;
});

async function start(email?: EmailSenderPort): Promise<Started> {
  const config = loadConfig({
    KB_VAULT: FIXTURE_VAULT,
    KB_CHAT_SEARCH: 'fixture',
    KB_CHAT_OWNER_EMAIL: OWNER_EMAIL,
    WEB_ORIGIN: ORIGIN,
    LOG_LEVEL: 'silent',
    AUTH_RATE_LIMIT: '1000',
  });
  const keys = await createTestKeys();
  const vault = new FsVaultAdapter(config.KB_VAULT);
  const index = await createSearchIndex({
    config,
    vault,
    log: createLogger('silent'),
  });
  const outbox = new MemoryOutbox();
  const app = await buildApp({
    config,
    vault,
    index,
    logger: createLogger('silent'),
    auth: {
      people: new PeopleService({
        store: new MemoryPeopleStore(),
        ownerEmail: OWNER_EMAIL,
      }),
      sessions: new SessionService({ store: new MemorySessionStore() }),
      verifier: testVerifier(keys),
    },
    access: {
      codes: new MemoryDocumentStore(),
      requests: new MemoryDocumentStore(),
      delivery: { email: email ?? outbox, sms: null },
    },
  });
  current = app;
  return { app, keys, outbox };
}

const cookieOf = (setCookie: unknown): string =>
  String(Array.isArray(setCookie) ? setCookie[0] : setCookie).split(';')[0] ??
  '';

async function session(
  started: Started,
  email: string,
  name = 'Ana Master',
): Promise<Record<string, string>> {
  const credential = await mintIdToken(started.keys, {
    email,
    sub: `sub-${email}`,
    name,
  });
  const response = await started.app.inject({
    method: 'POST',
    url: '/api/v1/auth/google',
    headers: LOCAL,
    payload: { credential },
  });
  expect(response.statusCode, response.body).toBe(200);
  return { ...LOCAL, cookie: cookieOf(response.headers['set-cookie']) };
}

const call =
  (app: FastifyInstance, headers: Record<string, string>) =>
  (method: InjectOptions['method'], url: string, payload?: object) =>
    app.inject({ method, url, headers, ...(payload && { payload }) });

describe('invitation e-mail (KBC-026)', () => {
  it('AC-1: inviting sends the e-mail with the inviter, the link and both ways in', async () => {
    const started = await start();
    const owner = call(started.app, await session(started, OWNER_EMAIL));

    const invited = await owner('POST', '/api/v1/people', {
      email: 'Novo@Exemplo.com',
    });

    expect(invited.statusCode).toBe(201);
    expect(invited.json().invitation).toEqual({
      sentAt: expect.any(String),
      failedAt: null,
    });
    const [mail, ...rest] = started.outbox.emailsTo('novo@exemplo.com');
    expect(rest).toEqual([]);
    expect(mail?.subject).toBe('Você foi convidado para a Nova Alexandria');
    expect(mail?.text).toContain('Ana Master convidou você');
    expect(mail?.text).toContain(ORIGIN);
    const listed = (await owner('GET', '/api/v1/people')).json().items as {
      email: string;
      invitation: unknown;
    }[];
    expect(
      listed.find((p) => p.email === 'novo@exemplo.com')?.invitation,
    ).toEqual(invited.json().invitation);
  });

  it('AC-2: "Não enviar e-mail" invites without any message', async () => {
    const started = await start();
    const owner = call(started.app, await session(started, OWNER_EMAIL));

    const invited = await owner('POST', '/api/v1/people', {
      email: 'quiet@example.com',
      sendEmail: false,
    });

    expect(invited.statusCode).toBe(201);
    expect(invited.json().invitation).toBeNull();
    expect(started.outbox.emailsTo('quiet@example.com')).toEqual([]);
  });

  it('AC-4: a resend right after the invite is limited with retryAt; nothing is sent', async () => {
    const started = await start();
    const owner = call(started.app, await session(started, OWNER_EMAIL));
    const { id } = (
      await owner('POST', '/api/v1/people', { email: 'guest@example.com' })
    ).json();

    const resent = await owner('POST', `/api/v1/people/${id}/invitation`);

    expect(resent.statusCode).toBe(429);
    expect(resent.json().error).toMatchObject({
      code: 'RATE_LIMITED',
      details: { retryAt: expect.any(String) },
    });
    expect(started.outbox.emailsTo('guest@example.com')).toHaveLength(1);
  });

  it('sends the first invitation of a person invited without e-mail', async () => {
    const started = await start();
    const owner = call(started.app, await session(started, OWNER_EMAIL));
    const { id } = (
      await owner('POST', '/api/v1/people', {
        email: 'later@example.com',
        sendEmail: false,
      })
    ).json();

    const sent = await owner('POST', `/api/v1/people/${id}/invitation`);

    expect(sent.statusCode).toBe(200);
    expect(sent.json().invitation.sentAt).toEqual(expect.any(String));
    expect(started.outbox.emailsTo('later@example.com')).toHaveLength(1);
  });

  it('AC-5: a refused e-mail keeps the invite and answers with failedAt', async () => {
    const started = await start({
      send: async () => {
        throw new Error('SMTP refused the email (EAUTH 535)');
      },
    });
    const owner = call(started.app, await session(started, OWNER_EMAIL));

    const invited = await owner('POST', '/api/v1/people', {
      email: 'unlucky@example.com',
    });

    expect(invited.statusCode).toBe(201);
    expect(invited.json().invitation).toEqual({
      sentAt: null,
      failedAt: expect.any(String),
    });
    const listed = (await owner('GET', '/api/v1/people')).json().items as {
      email: string;
    }[];
    expect(listed.map((p) => p.email)).toContain('unlucky@example.com');
  });

  it('AC-6: a member or no session cannot invite or resend, whether the address exists or not', async () => {
    const started = await start();
    const owner = call(started.app, await session(started, OWNER_EMAIL));
    const { id } = (
      await owner('POST', '/api/v1/people', {
        email: 'member@example.com',
        sendEmail: false,
      })
    ).json();
    const member = call(
      started.app,
      await session(started, 'member@example.com', 'Member'),
    );
    const anonymous = call(started.app, LOCAL);

    const answers = [
      await member('POST', '/api/v1/people', { email: 'member@example.com' }),
      await member('POST', '/api/v1/people', { email: 'nobody@example.com' }),
      await member('POST', `/api/v1/people/${id}/invitation`),
      await member(
        'POST',
        '/api/v1/people/33333333-3333-4333-8333-333333333333/invitation',
      ),
    ];
    expect(answers.map((r) => r.statusCode)).toEqual([403, 403, 403, 403]);
    expect(new Set(answers.map((r) => r.body)).size).toBe(1);
    expect(
      (await anonymous('POST', `/api/v1/people/${id}/invitation`)).statusCode,
    ).toBe(401);
    expect(started.outbox.emails).toEqual([]);
  });

  it('AC-7: refuses a resend to someone who already signed in, and 404 for nobody', async () => {
    const started = await start();
    const owner = call(started.app, await session(started, OWNER_EMAIL));
    const { id } = (
      await owner('POST', '/api/v1/people', {
        email: 'active@example.com',
        sendEmail: false,
      })
    ).json();
    await session(started, 'active@example.com', 'Active');

    expect(
      (await owner('POST', `/api/v1/people/${id}/invitation`)).statusCode,
    ).toBe(400);
    expect(
      (
        await owner(
          'POST',
          '/api/v1/people/33333333-3333-4333-8333-333333333333/invitation',
        )
      ).statusCode,
    ).toBe(404);
    expect(started.outbox.emailsTo('active@example.com')).toEqual([]);
  });
});
