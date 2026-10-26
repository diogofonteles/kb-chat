import { describe, expect, it } from 'vitest';
import { LogEmailSender } from './adapters/log-email-sender.js';
import { ResendEmailSender } from './adapters/resend-email-sender.js';
import { SmtpEmailSender } from './adapters/smtp-email-sender.js';
import { loadConfig } from './config.js';
import { createDelivery } from './delivery-factory.js';
import { createLogger } from './logger.js';

const log = createLogger('silent');
const smtp = { SMTP_USER: 'kbchat@gmail.com', SMTP_PASSWORD: 'app-password' };
const resend = {
  RESEND_API_KEY: 're_test',
  KB_CHAT_EMAIL_FROM: 'kb-chat <a@example.com>',
};

describe('createDelivery (KBC-015 AC-4)', () => {
  it('prefers Gmail SMTP when its pair is set, even next to Resend', () => {
    const { email } = createDelivery(loadConfig({ ...smtp, ...resend }), log);
    expect(email).toBeInstanceOf(SmtpEmailSender);
  });

  it('sends from the Gmail account by default', () => {
    const { email } = createDelivery(loadConfig(smtp), log);
    expect((email as SmtpEmailSender).from).toBe(
      'Nova Alexandria <kbchat@gmail.com>',
    );
    const custom = createDelivery(
      loadConfig({ ...smtp, KB_CHAT_EMAIL_FROM: 'Kb <kbchat@gmail.com>' }),
      log,
    ).email;
    expect((custom as SmtpEmailSender).from).toBe('Kb <kbchat@gmail.com>');
  });

  it('falls back to Resend, then to the development log', () => {
    expect(createDelivery(loadConfig(resend), log).email).toBeInstanceOf(
      ResendEmailSender,
    );
    expect(createDelivery(loadConfig({}), log).email).toBeInstanceOf(
      LogEmailSender,
    );
  });

  it('keeps SMS off unless KB_CHAT_SMS=log', () => {
    expect(createDelivery(loadConfig({}), log).sms).toBeNull();
    expect(
      createDelivery(loadConfig({ KB_CHAT_SMS: 'log' }), log).sms,
    ).not.toBeNull();
  });
});
