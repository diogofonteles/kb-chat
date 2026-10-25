import type { FastifyBaseLogger } from 'fastify';
import type { EmailMessage, EmailSenderPort } from '../ports/email-sender.js';
import type { SmsMessage, SmsSenderPort } from '../ports/sms-sender.js';

/**
 * Development only (ADR 0011): the message, code included, goes to the API log instead of
 * a provider. The composition never builds it in production (assertDeliveryConfigured).
 */
export class LogEmailSender implements EmailSenderPort {
  constructor(private readonly log: FastifyBaseLogger) {}

  async send(message: EmailMessage): Promise<void> {
    this.log.warn(
      { to: message.to, subject: message.subject, text: message.text },
      'email not sent (development log adapter)',
    );
  }
}

/** Development only: KB_CHAT_SMS=log writes the text message to the API log. */
export class LogSmsSender implements SmsSenderPort {
  constructor(private readonly log: FastifyBaseLogger) {}

  async send(message: SmsMessage): Promise<void> {
    this.log.warn(
      { to: message.to, text: message.text },
      'sms not sent (development log adapter)',
    );
  }
}
