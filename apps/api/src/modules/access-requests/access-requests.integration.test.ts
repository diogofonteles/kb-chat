import type { FastifyInstance, InjectOptions } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
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
import { buildApp } from '../../app.js';
import { loadConfig } from '../../config.js';
import { createLogger } from '../../logger.js';
import { createSearchIndex } from '../../search-index-factory.js';
import { PeopleService, SessionService } from '../auth/index.js';

const OWNER_EMAIL = 'owner@example.com';
const LOCAL = { host: 'localhost:3000', [CSRF_HEADER]: CSRF_HEADER_VALUE };

interface Started {
  readonly app: FastifyInstance;
  readonly keys: TestKeys;
  readonly outbox: MemoryOutbox;
  readonly people: PeopleService;
}

let current: FastifyInstance | null = null;
afterEach(async () => {
  await current?.close();
  current = null;
});

async function start(options: { sms?: boolean } = {}): Promise<Started> {
  const config = loadConfig({
    KB_VAULT: FIXTURE_VAULT,
    KB_CHAT_SEARCH: 'fixture',
    KB_CHAT_OWNER_EMAIL: OWNER_EMAIL,
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
  const people = new PeopleService({
    store: new MemoryPeopleStore(),
    ownerEmail: OWNER_EMAIL,
  });
  const outbox = new MemoryOutbox();
  const app = await buildApp({
    config,
    vault,
    index,
    logger: createLogger('silent'),
    auth: {
      people,
      sessions: new SessionService({ store: new MemorySessionStore() }),
      verifier: testVerifier(keys),
    },
    access: {
      codes: new MemoryDocumentStore(),
      requests: new MemoryDocumentStore(),
      delivery: { email: outbox, sms: options.sms ? outbox.smsSender : null },
    },
  });
  current = app;
  return { app, keys, outbox, people };
}

let address = 0;
/** Each call from its own client address, unless a test pins one (BR-5 counts per address). */
const send = (
  app: FastifyInstance,
  options: InjectOptions & { headers?: Record<string, string> },
) =>
  app.inject({
    remoteAddress: `10.0.${Math.floor(address / 250)}.${(address++ % 250) + 1}`,
    ...options,
    headers: { ...LOCAL, ...options.headers },
  });

const post = (app: FastifyInstance, url: string, payload: object) =>
  send(app, { method: 'POST', url, payload });

/** POST as a signed-in person (their cookie). */
const postAs =
  (headers: Record<string, string>) =>
  (app: FastifyInstance, url: string, payload: object) =>
    send(app, { method: 'POST', url, payload, headers });

const cookieOf = (setCookie: unknown): string =>
  String(Array.isArray(setCookie) ? setCookie[0] : setCookie).split(';')[0] ??
  '';

async function googleSignIn(started: Started, email: string) {
  const credential = await mintIdToken(started.keys, {
    email,
    sub: `sub-${email}`,
    name: 'Bia Souza',
  });
  return post(started.app, '/api/v1/auth/google', { credential });
}

async function ownerSession(started: Started): Promise<Record<string, string>> {
  const response = await googleSignIn(started, OWNER_EMAIL);
  expect(response.statusCode).toBe(200);
  return { cookie: cookieOf(response.headers['set-cookie']) };
}

/** The last message's six-digit code to `to`, once the delivery after the reply ran. */
async function codeSentTo(
  outbox: MemoryOutbox,
  to: string,
  count = 1,
): Promise<string> {
  await vi.waitFor(() =>
    expect(outbox.to(to).length).toBeGreaterThanOrEqual(count),
  );
  const text = outbox.to(to).at(-1)?.text ?? '';
  const code = /\b(\d{6})\b/.exec(text)?.[1];
  if (!code) throw new Error(`no code in: ${text}`);
  return code;
}

const form = (email: string) => ({
  email,
  firstName: 'Ana',
  lastName: 'Lima',
  phone: '(81) 99999-0000',
});

/** A form sign-up up to the pending request. */
async function signUp(started: Started, email: string) {
  expect(
    (await post(started.app, '/api/v1/access-requests/signup', form(email)))
      .statusCode,
  ).toBe(202);
  const code = await codeSentTo(started.outbox, email);
  return post(started.app, '/api/v1/access-requests/signup/verify', {
    email,
    code,
  });
}

async function pendingList(started: Started, owner: Record<string, string>) {
  const response = await send(started.app, {
    method: 'GET',
    url: '/api/v1/access-requests',
    headers: owner,
  });
  expect(response.statusCode).toBe(200);
  return response.json().items as {
    id: string;
    email: string;
    source: string;
    phone: string | null;
  }[];
}

/**
 * Gives deliveries queued after the replies time to run, for checks that nothing was sent
 * (a positive check waits for its message with vi.waitFor instead).
 */
const settle = () => new Promise((resolve) => setTimeout(resolve, 300));

describe('sign-up without Google (KBC-014 FR-1, FR-2)', () => {
  it('AC-1: the confirmed form becomes a pending request and masters get an email', async () => {
    const started = await start();
    const owner = await ownerSession(started);

    const verified = await signUp(started, 'Ana@Example.com'.toLowerCase());

    expect(verified.statusCode).toBe(201);
    expect(verified.json()).toEqual({ status: 'pending' });
    const [request] = await pendingList(started, owner);
    expect(request).toMatchObject({
      email: 'ana@example.com',
      source: 'form',
      phone: '+5581999990000',
    });
    await vi.waitFor(() =>
      expect(started.outbox.emailsTo(OWNER_EMAIL).at(-1)?.subject).toBe(
        'Nova solicitação de acesso: Ana Lima',
      ),
    );
  });

  it('refuses a wrong code and keeps no request', async () => {
    const started = await start();
    await post(
      started.app,
      '/api/v1/access-requests/signup',
      form('ana@example.com'),
    );
    const code = await codeSentTo(started.outbox, 'ana@example.com');
    const wrong = code === '000000' ? '111111' : '000000';

    const response = await post(
      started.app,
      '/api/v1/access-requests/signup/verify',
      { email: 'ana@example.com', code: wrong },
    );

    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('INVALID_CODE');
    expect(await pendingList(started, await ownerSession(started))).toEqual([]);
  });

  it('AC-11: refuses a phone that cannot be one', async () => {
    const { app } = await start();
    const response = await post(app, '/api/v1/access-requests/signup', {
      ...form('ana@example.com'),
      phone: '123',
    });
    expect(response.statusCode).toBe(400);
  });
});

describe('no account enumeration (BR-3, NFR-3)', () => {
  it('AC-2: answers the same for a person, a pending request and an unknown email', async () => {
    const started = await start();
    const owner = await ownerSession(started);
    // Pending through Google, so its sign-up budget of this minute is untouched.
    const { ticket } = (
      await googleSignIn(started, 'pending@example.com')
    ).json().error.details;
    await post(started.app, '/api/v1/access-requests/google', { ticket });
    const known = await postAs(owner)(started.app, '/api/v1/people', {
      email: 'known@example.com',
      // The invitation e-mail (KBC-026) is not what these counts are about.
      sendEmail: false,
    });
    expect(known.statusCode).toBe(201);
    const emails = [
      'known@example.com',
      'pending@example.com',
      'new@example.com',
    ];

    const signUps = await Promise.all(
      emails.map((email) =>
        post(started.app, '/api/v1/access-requests/signup', form(email)),
      ),
    );
    const codes = await Promise.all(
      emails.map((identifier) =>
        post(started.app, '/api/v1/auth/code', {
          identifier,
          channel: 'email',
        }),
      ),
    );

    for (const response of [...signUps, ...codes]) {
      expect(response.statusCode).toBe(202);
      expect(response.body).toBe('{}');
    }
    // Deliveries run after the replies; wait until all three went out.
    await vi.waitFor(() => {
      expect(
        started.outbox
          .to('known@example.com')
          .map((m) => 'subject' in m && m.subject),
      ).toEqual([
        'Você já tem acesso à Nova Alexandria',
        'Seu código de acesso à Nova Alexandria',
      ]);
      expect(started.outbox.to('pending@example.com').at(-1)).toMatchObject({
        subject: 'Sua solicitação de acesso à Nova Alexandria está em análise',
      });
      expect(started.outbox.to('new@example.com').at(-1)).toMatchObject({
        subject: 'Confirme seu e-mail na Nova Alexandria',
      });
    });
  });

  it('AC-7: sends one code per minute per email, answering 429 to the second ask', async () => {
    const started = await start();
    const ask = () =>
      post(started.app, '/api/v1/auth/code', {
        identifier: OWNER_EMAIL,
        channel: 'email',
      });

    expect((await ask()).statusCode).toBe(202);
    const second = await ask();

    expect(second.statusCode).toBe(429);
    expect(second.json().error.code).toBe('RATE_LIMITED');
    // The first code arrives (delivery runs after the reply); no second one follows it.
    await vi.waitFor(() =>
      expect(started.outbox.to(OWNER_EMAIL)).toHaveLength(1),
    );
    await settle();
    expect(started.outbox.to(OWNER_EMAIL)).toHaveLength(1);
  });

  it('counts sends per client address too', async () => {
    const { app } = await start();
    const from = (n: number) =>
      send(app, {
        method: 'POST',
        url: '/api/v1/auth/code',
        remoteAddress: '10.9.9.9',
        payload: { identifier: `p${n}@example.com`, channel: 'email' },
      });
    const statuses = [];
    for (let n = 0; n < 6; n += 1) statuses.push((await from(n)).statusCode);
    expect(statuses).toEqual([202, 202, 202, 202, 202, 429]);
  });
});

describe('approval gate and decisions (BR-1, BR-6, BR-7)', () => {
  it('AC-3: a pending person gets no sign-in code and no session', async () => {
    const started = await start();
    await signUp(started, 'ana@example.com');
    const before = started.outbox.to('ana@example.com').length;

    expect(
      (
        await post(started.app, '/api/v1/auth/code', {
          identifier: 'ana@example.com',
          channel: 'email',
        })
      ).statusCode,
    ).toBe(202);
    await settle();
    expect(started.outbox.to('ana@example.com')).toHaveLength(before);
    const attempt = await post(started.app, '/api/v1/auth/code/verify', {
      identifier: 'ana@example.com',
      code: '123456',
    });
    expect(attempt.statusCode).toBe(400);
    expect(attempt.headers['set-cookie']).toBeUndefined();
  });

  it('AC-4 and AC-5: approving gives invite defaults, emails the person, and their code opens a session once', async () => {
    const started = await start();
    const owner = await ownerSession(started);
    await signUp(started, 'ana@example.com');
    const [request] = await pendingList(started, owner);

    const approved = await postAs(owner)(
      started.app,
      `/api/v1/access-requests/${request?.id}/approve`,
      {},
    );

    expect(approved.statusCode).toBe(201);
    expect(approved.json()).toMatchObject({
      email: 'ana@example.com',
      name: 'Ana Lima',
      phone: '+5581999990000',
      role: 'member',
      topics: [],
      features: ['search'],
      invitedBy: OWNER_EMAIL,
    });
    expect(await pendingList(started, owner)).toEqual([]);
    await vi.waitFor(() =>
      expect(started.outbox.to('ana@example.com').at(-1)).toMatchObject({
        subject: 'Seu acesso à Nova Alexandria foi aprovado',
      }),
    );

    await post(started.app, '/api/v1/auth/code', {
      identifier: 'ANA@example.com',
      channel: 'email',
    });
    const code = await codeSentTo(started.outbox, 'ana@example.com', 3);
    const signedIn = await post(started.app, '/api/v1/auth/code/verify', {
      identifier: 'ana@example.com',
      code,
    });
    expect(signedIn.statusCode).toBe(200);
    expect(signedIn.json()).toMatchObject({
      email: 'ana@example.com',
      features: ['search'],
      topics: [],
    });
    const me = await send(started.app, {
      method: 'GET',
      url: '/api/v1/me',
      headers: { cookie: cookieOf(signedIn.headers['set-cookie']) },
    });
    expect(me.statusCode).toBe(200);
    const replay = await post(started.app, '/api/v1/auth/code/verify', {
      identifier: 'ana@example.com',
      code,
    });
    expect(replay.json().error.code).toBe('INVALID_CODE');
  });

  it('keeps the principal of a code person who later signs in with Google', async () => {
    const started = await start();
    const owner = await ownerSession(started);
    await signUp(started, 'ana@example.com');
    const [request] = await pendingList(started, owner);
    const person = (
      await postAs(owner)(
        started.app,
        `/api/v1/access-requests/${request?.id}/approve`,
        {},
      )
    ).json();

    const google = await googleSignIn(started, 'ana@example.com');

    expect(google.statusCode).toBe(200);
    const stored = (await started.people.list()).find(
      (p) => p.email === 'ana@example.com',
    );
    expect(stored).toMatchObject({
      sub: 'sub-ana@example.com',
      principal: person.id,
    });
    expect(started.people.viewerOf(stored ?? never()).principal).toBe(
      person.id,
    );
  });

  it('a person revoked after the code went out does not get in', async () => {
    const started = await start();
    const owner = await ownerSession(started);
    const invited = (
      await postAs(owner)(started.app, '/api/v1/people', {
        email: 'bia@example.com',
        // The invitation e-mail (KBC-026) is not what these counts are about.
        sendEmail: false,
      })
    ).json();
    await post(started.app, '/api/v1/auth/code', {
      identifier: 'bia@example.com',
      channel: 'email',
    });
    const code = await codeSentTo(started.outbox, 'bia@example.com');

    await send(started.app, {
      method: 'DELETE',
      url: `/api/v1/people/${invited.id}`,
      headers: owner,
    });
    const attempt = await post(started.app, '/api/v1/auth/code/verify', {
      identifier: 'bia@example.com',
      code,
    });

    expect(attempt.json().error.code).toBe('INVALID_CODE');
  });

  it('approving a request whose email was invited meanwhile clears it and returns that person', async () => {
    const started = await start();
    const owner = await ownerSession(started);
    await signUp(started, 'ana@example.com');
    const [request] = await pendingList(started, owner);
    const invited = (
      await postAs(owner)(started.app, '/api/v1/people', {
        email: 'ana@example.com',
      })
    ).json();

    const approved = await postAs(owner)(
      started.app,
      `/api/v1/access-requests/${request?.id}/approve`,
      {},
    );

    expect(approved.statusCode).toBe(201);
    expect(approved.json().id).toBe(invited.id);
    expect(await pendingList(started, owner)).toEqual([]);
  });

  it('SMS reaches nobody when two people share a phone (ADR 0011)', async () => {
    const started = await start({ sms: true });
    const owner = await ownerSession(started);
    for (const email of ['ana@example.com', 'bia@example.com'])
      await signUp(started, email);
    for (const request of await pendingList(started, owner))
      await postAs(owner)(
        started.app,
        `/api/v1/access-requests/${request.id}/approve`,
        {},
      );

    await post(started.app, '/api/v1/auth/code', {
      identifier: '81999990000',
      channel: 'sms',
    });
    await settle();

    expect(started.outbox.sms).toEqual([]);
  });

  it('AC-10: only masters list, approve and refuse', async () => {
    const started = await start();
    const owner = await ownerSession(started);
    await postAs(owner)(started.app, '/api/v1/people', {
      email: 'guest@example.com',
    });
    const guest = await googleSignIn(started, 'guest@example.com');
    const headers = { cookie: cookieOf(guest.headers['set-cookie']) };
    const id = '11111111-1111-4111-8111-111111111111';

    expect(
      (
        await send(started.app, {
          method: 'GET',
          url: '/api/v1/access-requests',
          headers,
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await postAs(headers)(
          started.app,
          `/api/v1/access-requests/${id}/approve`,
          {},
        )
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await postAs(headers)(
          started.app,
          `/api/v1/access-requests/${id}/refuse`,
          {},
        )
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await send(started.app, {
          method: 'GET',
          url: '/api/v1/access-requests',
        })
      ).statusCode,
    ).toBe(401);
    expect(
      (
        await postAs(owner)(
          started.app,
          `/api/v1/access-requests/${id}/approve`,
          {},
        )
      ).statusCode,
    ).toBe(404);
  });
});

describe('Google without an invite (FR-3)', () => {
  it('AC-8: the not-invited answer carries a single-use ticket that becomes a pending request', async () => {
    const started = await start();
    const owner = await ownerSession(started);

    const refused = await googleSignIn(started, 'bia@gmail.com');

    expect(refused.statusCode).toBe(403);
    const { ticket, request } = refused.json().error.details;
    expect(request).toEqual({ status: 'none' });
    const created = await post(started.app, '/api/v1/access-requests/google', {
      ticket,
      phone: '81988887777',
    });
    expect(created.statusCode).toBe(201);
    const replay = await post(started.app, '/api/v1/access-requests/google', {
      ticket,
    });
    expect(replay.json().error.code).toBe('REQUEST_EXPIRED');
    const [pending] = await pendingList(started, owner);
    expect(pending).toMatchObject({
      email: 'bia@gmail.com',
      source: 'google',
      phone: '+5581988887777',
    });
    expect(
      (await googleSignIn(started, 'bia@gmail.com')).json().error.details
        .request,
    ).toEqual({ status: 'pending' });

    await postAs(owner)(
      started.app,
      `/api/v1/access-requests/${pending?.id}/approve`,
      {},
    );
    expect((await googleSignIn(started, 'bia@gmail.com')).statusCode).toBe(200);
  });

  it('refusing keeps the person out for a day and tells their Google identity when to retry', async () => {
    const started = await start();
    const owner = await ownerSession(started);
    const { ticket } = (await googleSignIn(started, 'bia@gmail.com')).json()
      .error.details;
    await post(started.app, '/api/v1/access-requests/google', { ticket });
    const [pending] = await pendingList(started, owner);

    const refusal = await postAs(owner)(
      started.app,
      `/api/v1/access-requests/${pending?.id}/refuse`,
      {},
    );

    expect(refusal.statusCode).toBe(204);
    expect(await pendingList(started, owner)).toEqual([]);
    const again = (await googleSignIn(started, 'bia@gmail.com')).json().error
      .details;
    expect(again.request).toMatchObject({ status: 'refused' });
    const second = await post(started.app, '/api/v1/access-requests/google', {
      ticket: again.ticket,
    });
    expect(second.statusCode).toBe(429);
    expect(second.json().error).toMatchObject({
      code: 'REQUEST_COOLDOWN',
      details: { retryAt: again.request.retryAt },
    });
  });
});

describe('code channels (BR-9, FR-6)', () => {
  it('AC-12: offers email only while SMS is off, and refuses an SMS code', async () => {
    const { app } = await start();
    expect(
      (await send(app, { method: 'GET', url: '/api/v1/auth/config' })).json()
        .codeChannels,
    ).toEqual(['email']);
    const sms = await post(app, '/api/v1/auth/code', {
      identifier: '81999990000',
      channel: 'sms',
    });
    expect(sms.statusCode).toBe(400);
  });

  it('sends the code by SMS to a person with that phone when SMS is on', async () => {
    const started = await start({ sms: true });
    const owner = await ownerSession(started);
    expect(
      (
        await send(started.app, { method: 'GET', url: '/api/v1/auth/config' })
      ).json().codeChannels,
    ).toEqual(['email', 'sms']);
    await signUp(started, 'ana@example.com');
    const [request] = await pendingList(started, owner);
    await postAs(owner)(
      started.app,
      `/api/v1/access-requests/${request?.id}/approve`,
      {},
    );

    await post(started.app, '/api/v1/auth/code', {
      identifier: '(81) 99999-0000',
      channel: 'sms',
    });
    const code = await codeSentTo(started.outbox, '+5581999990000');
    const signedIn = await post(started.app, '/api/v1/auth/code/verify', {
      identifier: '+55 81 99999-0000',
      code,
    });

    expect(signedIn.statusCode).toBe(200);
    expect(signedIn.json().email).toBe('ana@example.com');
  });
});

function never(): never {
  throw new Error('missing');
}
