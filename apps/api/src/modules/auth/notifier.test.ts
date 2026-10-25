import { describe, expect, it } from 'vitest';
import { MemoryOutbox } from '../../adapters/memory-outbox.js';
import { Notifier } from './notifier.js';

const origin = 'https://kb.example.com';

describe('Notifier (KBC-014, ADR 0011)', () => {
  it('tells a refused person when they may ask again, in Brasília time', async () => {
    const outbox = new MemoryOutbox();
    await new Notifier({
      email: outbox,
      sms: null,
      webOrigin: origin,
    }).requestCooldown('ana@example.com', '2026-10-26T13:30:00.000Z');

    expect(outbox.emails[0]?.text).toContain('a partir de 26/10/2026, 10:30');
  });

  it('refuses an SMS code while no SMS provider is configured', async () => {
    const notifier = new Notifier({
      email: new MemoryOutbox(),
      sms: null,
      webOrigin: origin,
    });

    expect(notifier.smsEnabled).toBe(false);
    await expect(
      notifier.sendCode(
        { channel: 'sms', address: '+5581999990000' },
        { purpose: 'login', value: '123456' },
      ),
    ).rejects.toThrow('No SMS provider');
  });

  it('greets an approved person by first name and points to the app', async () => {
    const outbox = new MemoryOutbox();
    const notifier = new Notifier({
      email: outbox,
      sms: outbox.smsSender,
      webOrigin: origin,
    });

    await notifier.approved('ana@example.com', 'Ana');
    await notifier.approved('bia@example.com', '');
    await notifier.sendCode(
      { channel: 'sms', address: '+5581999990000' },
      { purpose: 'login', value: '123456' },
    );

    expect(outbox.emails.map((m) => m.text.split('!')[0])).toEqual([
      'Olá, Ana',
      'Olá',
    ]);
    expect(outbox.emails[0]?.text).toContain(origin);
    expect(outbox.sms[0]).toEqual({
      to: '+5581999990000',
      text: 'kb-chat: seu código de acesso é 123456. Vale por 10 minutos.',
    });
  });
});
