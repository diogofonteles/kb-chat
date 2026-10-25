import type { FastifyBaseLogger } from 'fastify';
import type { AppConfig } from './config.js';
import { LogEmailSender, LogSmsSender } from './adapters/log-email-sender.js';
import { ResendEmailSender } from './adapters/resend-email-sender.js';
import { SmtpEmailSender } from './adapters/smtp-email-sender.js';
import type { EmailSenderPort } from './ports/email-sender.js';
import type { SmsSenderPort } from './ports/sms-sender.js';

/** Resend's test sender: it delivers only to the Resend account's own address. */
const RESEND_TEST_FROM = 'kb-chat <onboarding@resend.dev>';

export interface Delivery {
  readonly email: EmailSenderPort;
  /** Null while SMS is off (KBC-014 BR-9). */
  readonly sms: SmsSenderPort | null;
}

/**
 * Email through Gmail SMTP when its pair is set (ADR 0012), else Resend (ADR 0011), else
 * the API log (development only: main asserts production has a provider); SMS through the
 * log only when KB_CHAT_SMS=log.
 */
export function createDelivery(
  config: AppConfig,
  log: FastifyBaseLogger,
): Delivery {
  const sms = config.KB_CHAT_SMS === 'log' ? new LogSmsSender(log) : null;
  return { email: createEmailSender(config, log), sms };
}

function createEmailSender(
  config: AppConfig,
  log: FastifyBaseLogger,
): EmailSenderPort {
  if (config.SMTP_USER && config.SMTP_PASSWORD)
    return new SmtpEmailSender({
      host: config.SMTP_HOST,
      port: config.SMTP_PORT,
      user: config.SMTP_USER,
      password: config.SMTP_PASSWORD,
      from: config.KB_CHAT_EMAIL_FROM ?? `kb-chat <${config.SMTP_USER}>`,
    });
  if (config.RESEND_API_KEY)
    return new ResendEmailSender({
      apiKey: config.RESEND_API_KEY,
      from: config.KB_CHAT_EMAIL_FROM ?? RESEND_TEST_FROM,
    });
  return new LogEmailSender(log);
}
