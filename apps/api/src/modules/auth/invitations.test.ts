import type { FastifyBaseLogger } from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import { MemoryOutbox } from '../../adapters/memory-outbox.js';
import { MemoryPeopleStore } from '../../adapters/memory-people-store.js';
import type { EmailSenderPort } from '../../ports/email-sender.js';
import { Invitations } from './invitations.js';
import { Notifier } from './notifier.js';
import { PeopleService } from './people-service.js';

const ORIGIN = 'https://nova-alexandria.duckdns.org';
const MINUTE = 60_000;

function fakeLog() {
  const log = { warn: vi.fn(), error: vi.fn() };
  return { log, logger: log as unknown as FastifyBaseLogger };
}

async function setup(email: EmailSenderPort = new MemoryOutbox()) {
  let now = Date.parse('2026-10-26T12:00:00.000Z');
  const people = new PeopleService({
    store: new MemoryPeopleStore(),
    ownerEmail: 'owner@example.com',
    now: () => new Date(now),
  });
  const invitations = new Invitations({
    people,
    notifier: new Notifier({ email, sms: null, webOrigin: ORIGIN }),
    now: () => now,
  });
  const [owner] = await people.list();
  if (!owner) throw new Error('no owner');
  const master = { ...owner, name: 'Ana Master' };
  const guest = await people.invite('guest@example.com', owner.email);
  return {
    people,
    invitations,
    master,
    guest,
    advance: (ms: number) => (now += ms),
  };
}

describe('Invitations (KBC-026)', () => {
  it('AC-1: sends the invitation from the master by name and records when', async () => {
    const outbox = new MemoryOutbox();
    const { invitations, master, guest } = await setup(outbox);
    const { logger } = fakeLog();

    const sent = await invitations.afterInvite(guest, master, logger);

    expect(outbox.emailsTo('guest@example.com')).toHaveLength(1);
    expect(outbox.emailsTo('guest@example.com')[0]?.text).toContain(
      'Ana Master convidou você',
    );
    expect(sent.invitation).toEqual({
      sentAt: '2026-10-26T12:00:00.000Z',
      failedAt: null,
    });
  });

  it('names the master by e-mail when they have no name yet', async () => {
    const outbox = new MemoryOutbox();
    const { invitations, master, guest } = await setup(outbox);

    await invitations.afterInvite(
      guest,
      { ...master, name: '' },
      fakeLog().logger,
    );

    expect(outbox.emailsTo('guest@example.com')[0]?.text).toContain(
      'owner@example.com convidou você',
    );
  });

  it('AC-4: refuses a resend within 10 minutes with the time it fits, then allows it', async () => {
    const outbox = new MemoryOutbox();
    const { invitations, master, guest, advance } = await setup(outbox);
    const { logger } = fakeLog();
    await invitations.afterInvite(guest, master, logger);
    advance(4 * MINUTE);

    await expect(
      invitations.resend(guest.id, master, logger),
    ).rejects.toMatchObject({
      code: 'RATE_LIMITED',
      details: { retryAt: '2026-10-26T12:10:00.000Z' },
    });
    expect(outbox.emailsTo('guest@example.com')).toHaveLength(1);

    advance(6 * MINUTE);
    const resent = await invitations.resend(guest.id, master, logger);
    expect(resent.invitation?.sentAt).toBe('2026-10-26T12:10:00.000Z');
    expect(outbox.emailsTo('guest@example.com')).toHaveLength(2);
  });

  it('AC-4: allows at most five invitations a day per invitee', async () => {
    const { invitations, master, guest, advance } = await setup();
    const { logger } = fakeLog();
    await invitations.afterInvite(guest, master, logger);
    for (let i = 0; i < 4; i += 1) {
      advance(10 * MINUTE);
      await invitations.resend(guest.id, master, logger);
    }
    advance(10 * MINUTE);

    await expect(
      invitations.resend(guest.id, master, logger),
    ).rejects.toMatchObject({
      code: 'RATE_LIMITED',
      details: { retryAt: '2026-10-27T12:00:00.000Z' },
    });
  });

  it('keeps the invite without an e-mail when it is already over the limit', async () => {
    const outbox = new MemoryOutbox();
    const { invitations, people, master, guest } = await setup(outbox);
    const { log, logger } = fakeLog();
    await invitations.afterInvite(guest, master, logger);
    await people.revoke(guest.id);
    const again = await people.invite('guest@example.com', master.email);

    const result = await invitations.afterInvite(again, master, logger);

    expect(result.invitation ?? null).toBeNull();
    expect(outbox.emailsTo('guest@example.com')).toHaveLength(1);
    expect(log.warn).toHaveBeenCalledOnce();
  });

  it('AC-5: a provider failure keeps the invite, records it and logs no e-mail text', async () => {
    const failing: EmailSenderPort = {
      send: async () => {
        throw new Error('SMTP refused the email (EAUTH 535)');
      },
    };
    const { invitations, people, master, guest } = await setup(failing);
    const { log, logger } = fakeLog();

    const result = await invitations.afterInvite(guest, master, logger);

    expect(result.invitation).toEqual({
      sentAt: null,
      failedAt: '2026-10-26T12:00:00.000Z',
    });
    expect(await people.find(guest.id)).toMatchObject({
      invitation: { failedAt: '2026-10-26T12:00:00.000Z' },
    });
    expect(log.error).toHaveBeenCalledOnce();
    const logged = JSON.stringify(log.error.mock.calls[0]);
    expect(logged).toContain(guest.id);
    expect(logged).not.toMatch(/convidou|Nova Alexandria|guest@example\.com/);
  });

  it('AC-5: a failed resend keeps the earlier sentAt', async () => {
    let fail = false;
    const flaky: EmailSenderPort = {
      send: async () => {
        if (fail) throw new Error('down');
      },
    };
    const { invitations, master, guest, advance } = await setup(flaky);
    const { logger } = fakeLog();
    await invitations.afterInvite(guest, master, logger);
    fail = true;
    advance(10 * MINUTE);

    const result = await invitations.resend(guest.id, master, logger);

    expect(result.invitation).toEqual({
      sentAt: '2026-10-26T12:00:00.000Z',
      failedAt: '2026-10-26T12:10:00.000Z',
    });
  });

  it('AC-7: refuses a resend to someone who already signed in, and to nobody', async () => {
    const { invitations, people, master, guest } = await setup();
    await people.signInWithCode(guest.id);
    const { logger } = fakeLog();

    await expect(
      invitations.resend(guest.id, master, logger),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(
      invitations.resend('33333333-3333-4333-8333-333333333333', master, logger),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});
