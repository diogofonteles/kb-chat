import { mkdtemp, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createLogger } from '../logger.js';
import { JsonDocumentStore } from './json-document-store.js';
import { LogEmailSender, LogSmsSender } from './log-email-sender.js';
import { ResendEmailSender } from './resend-email-sender.js';

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
