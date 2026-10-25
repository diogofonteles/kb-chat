import type { FastifyBaseLogger } from 'fastify';
import type { AppConfig } from './config.js';
import { LogEmailSender, LogSmsSender } from './adapters/log-email-sender.js';
import { ResendEmailSender } from './adapters/resend-email-sender.js';
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
 * Email through Resend, else the API log (development only: main asserts production has
 * Resend); SMS through the log only when KB_CHAT_SMS=log (ADR 0011).
 */
export function createDelivery(
  config: AppConfig,
  log: FastifyBaseLogger,
): Delivery {
  const email = config.RESEND_API_KEY
    ? new ResendEmailSender({
        apiKey: config.RESEND_API_KEY,
        from: config.KB_CHAT_EMAIL_FROM ?? RESEND_TEST_FROM,
      })
    : new LogEmailSender(log);
  const sms = config.KB_CHAT_SMS === 'log' ? new LogSmsSender(log) : null;
  return { email, sms };
}
