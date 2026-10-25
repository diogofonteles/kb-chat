import type { EmailMessage, EmailSenderPort } from '../ports/email-sender.js';

const RESEND_URL = 'https://api.resend.com/emails';
const TIMEOUT_MS = 8_000;

export interface ResendOptions {
  readonly apiKey: string;
  /** A sender on a domain verified in Resend, e.g. "kb-chat <nao-responda@example.com>". */
  readonly from: string;
  readonly fetch?: typeof fetch;
}

/** Resend's HTTP API (ADR 0011), the provider of the owner's other app. */
export class ResendEmailSender implements EmailSenderPort {
  constructor(private readonly options: ResendOptions) {}

  async send(message: EmailMessage): Promise<void> {
    const send = this.options.fetch ?? fetch;
    const response = await send(RESEND_URL, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.options.apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ from: this.options.from, ...message }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!response.ok)
      throw new Error(`Resend refused the email (HTTP ${response.status})`);
  }
}
