import type { EmailMessage, EmailSenderPort } from '../ports/email-sender.js';
import type { SmsMessage, SmsSenderPort } from '../ports/sms-sender.js';

/** Every message "sent", kept in memory (tests and the E2E server; ADR 0011). */
export class MemoryOutbox implements EmailSenderPort {
  readonly emails: EmailMessage[] = [];
  readonly sms: SmsMessage[] = [];
  /** The SMS side of the same outbox. */
  readonly smsSender: SmsSenderPort = {
    send: async (message) => {
      this.sms.push(message);
    },
  };

  async send(message: EmailMessage): Promise<void> {
    this.emails.push(message);
  }

  /** The emails to an address, oldest first. */
  emailsTo(address: string): readonly EmailMessage[] {
    return this.emails.filter((m) => m.to === address);
  }

  /** Every message to an address or number, oldest first. */
  to(address: string): readonly (EmailMessage | SmsMessage)[] {
    return [...this.emails, ...this.sms].filter((m) => m.to === address);
  }
}
