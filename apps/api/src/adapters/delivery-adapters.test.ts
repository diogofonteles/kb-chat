import { mkdtemp, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createLogger } from '../logger.js';
import { JsonDocumentStore } from './json-document-store.js';
import { LogEmailSender, LogSmsSender } from './log-email-sender.js';
import { ResendEmailSender } from './resend-email-sender.js';
import {
  SmtpEmailSender,
  type SmtpTransportFactory,
} from './smtp-email-sender.js';

const message = {
  to: 'ana@example.com',
  subject: 'Assunto',
  text: 'Código: 123456',
};

describe('ResendEmailSender (ADR 0011)', () => {
  it('posts the message with the key and the sender to Resend', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(
      async () => new Response('{"id":"x"}'),
    );
    const sender = new ResendEmailSender({
      apiKey: 're_test',
      from: 'kb-chat <a@example.com>',
      fetch,
    });

    await sender.send(message);

    const [url, init] = fetch.mock.calls[0] ?? [];
    expect(url).toBe('https://api.resend.com/emails');
    expect(new Headers(init?.headers).get('authorization')).toBe(
      'Bearer re_test',
    );
    expect(JSON.parse(String(init?.body))).toEqual({
      from: 'kb-chat <a@example.com>',
      ...message,
    });
  });

  it('fails when Resend refuses, without the key in the error', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(
      async () => new Response('{}', { status: 403 }),
    );
    const sender = new ResendEmailSender({
      apiKey: 're_secret',
      from: 'a@example.com',
      fetch,
    });

    await expect(sender.send(message)).rejects.toThrow(
      'Resend refused the email (HTTP 403)',
    );
    await expect(sender.send(message)).rejects.not.toThrow(/re_secret/);
  });
});

describe('SmtpEmailSender (KBC-015, ADR 0012)', () => {
  const gmail = {
    host: 'smtp.gmail.com',
    port: 465,
    user: 'kbchat@gmail.com',
    password: 'app-password-secret',
    from: 'kb-chat <kbchat@gmail.com>',
  };

  function fakeTransport(sendMail: () => Promise<unknown> = async () => ({})) {
    const sent: unknown[] = [];
    const created: unknown[] = [];
    const createTransport: SmtpTransportFactory = (options) => {
      created.push(options);
      return {
        sendMail: async (mail) => {
          sent.push(mail);
          return sendMail();
        },
      };
    };
    return { createTransport, sent, created };
  }

  it('sends the message from the Gmail account through the transport (AC-1)', async () => {
    const transport = fakeTransport();
    const sender = new SmtpEmailSender({ ...gmail, ...transport });

    await sender.send(message);

    expect(transport.sent).toEqual([
      { from: 'kb-chat <kbchat@gmail.com>', ...message },
    ]);
  });

  it('uses implicit TLS on 465, password auth and 8 s timeouts (AC-2)', () => {
    const transport = fakeTransport();
    new SmtpEmailSender({ ...gmail, ...transport });

    expect(transport.created).toEqual([
      {
        host: 'smtp.gmail.com',
        port: 465,
        secure: true,
        requireTLS: false,
        auth: { user: 'kbchat@gmail.com', pass: 'app-password-secret' },
        connectionTimeout: 8_000,
        greetingTimeout: 8_000,
        socketTimeout: 8_000,
        dnsTimeout: 8_000,
      },
    ]);
  });

  it('requires STARTTLS on any other port (AC-2)', () => {
    const transport = fakeTransport();
    new SmtpEmailSender({ ...gmail, port: 587, ...transport });

    expect(transport.created[0]).toMatchObject({
      port: 587,
      secure: false,
      requireTLS: true,
    });
  });

  it('fails with the SMTP codes only, never the password or the message (AC-3)', async () => {
    const refusal = Object.assign(
      new Error(
        `Invalid login: 535 5.7.8 rejected app-password-secret ${message.text}`,
      ),
      { code: 'EAUTH', responseCode: 535, response: message.text },
    );
    const transport = fakeTransport(async () => {
      throw refusal;
    });
    const sender = new SmtpEmailSender({ ...gmail, ...transport });

    const error = await sender.send(message).then(
      () => null,
      (reason: unknown) => reason,
    );

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe('SMTP refused the email (EAUTH 535)');
    const visible = JSON.stringify(error, Object.getOwnPropertyNames(error));
    expect(visible).not.toContain('app-password-secret');
    expect(visible).not.toContain('123456');
    expect((error as Error).cause).toBeUndefined();
  });

  it('names an unknown failure without codes', async () => {
    const transport = fakeTransport(async () => {
      throw 'socket hang up';
    });
    const sender = new SmtpEmailSender({ ...gmail, ...transport });

    await expect(sender.send(message)).rejects.toThrow(
      'SMTP refused the email (unknown)',
    );
  });

  it('builds a real nodemailer transport when none is injected', () => {
    expect(() => new SmtpEmailSender(gmail)).not.toThrow();
  });
});

describe('log adapters (development only)', () => {
  it('write the message to the log instead of sending it', async () => {
    const log = createLogger('silent');
    const warn = vi.spyOn(log, 'warn');

    await new LogEmailSender(log).send(message);
    await new LogSmsSender(log).send({
      to: '+5581999990000',
      text: 'kb-chat: 123456',
    });

    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ to: 'ana@example.com' }),
      expect.stringContaining('email not sent'),
    );
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ to: '+5581999990000' }),
      expect.stringContaining('sms not sent'),
    );
  });
});

describe('JsonDocumentStore', () => {
  it('reads null before the first write, then the document, in a 0600 file', async () => {
    const file = join(
      await mkdtemp(join(tmpdir(), 'kbchat-doc-')),
      'codes.json',
    );
    const store = new JsonDocumentStore(file);

    expect(await store.read()).toBeNull();
    await store.write({ version: 1, codes: [] });

    expect(await store.read()).toEqual({ version: 1, codes: [] });
    expect((await stat(file)).mode & 0o777).toBe(0o600);
  });
});
