import nodemailer, { type SMTPTransportOptions } from 'nodemailer';
import type { EmailMessage, EmailSenderPort } from '../ports/email-sender.js';

const TIMEOUT_MS = 8_000;
const IMPLICIT_TLS_PORT = 465;

/** What the sender needs from a nodemailer transport: tests inject a fake one. */
export interface SmtpTransport {
  sendMail(mail: EmailMessage & { readonly from: string }): Promise<unknown>;
}

export type SmtpTransportFactory = (
  options: SMTPTransportOptions,
) => SmtpTransport;

export interface SmtpOptions {
  readonly host: string;
  readonly port: number;
  readonly user: string;
  /** A Gmail app password (secret): never logged nor put in an error. */
  readonly password: string;
  /** Gmail sends only as the account itself, e.g. "Nova Alexandria <kbchat@gmail.com>". */
  readonly from: string;
  readonly createTransport?: SmtpTransportFactory;
}

/**
 * Email over SMTP (ADR 0012): Gmail with an app password, free and to any recipient.
 * Port 465 speaks TLS from the start; any other port must upgrade with STARTTLS, so the
 * password never crosses the network in clear.
 */
export class SmtpEmailSender implements EmailSenderPort {
  private readonly transport: SmtpTransport;

  constructor(private readonly options: SmtpOptions) {
    const create =
      options.createTransport ??
      ((transportOptions) => nodemailer.createTransport(transportOptions));
    const secure = options.port === IMPLICIT_TLS_PORT;
    this.transport = create({
      host: options.host,
      port: options.port,
      secure,
      requireTLS: !secure,
      auth: { user: options.user, pass: options.password },
      connectionTimeout: TIMEOUT_MS,
      greetingTimeout: TIMEOUT_MS,
      socketTimeout: TIMEOUT_MS,
      dnsTimeout: TIMEOUT_MS,
    });
  }

  get from(): string {
    return this.options.from;
  }

  async send(message: EmailMessage): Promise<void> {
    try {
      await this.transport.sendMail({ from: this.options.from, ...message });
    } catch (error) {
      // Only the codes: nodemailer's message and response may echo the command or the body.
      throw new Error(`SMTP refused the email (${describeFailure(error)})`);
    }
  }
}

function describeFailure(error: unknown): string {
  if (typeof error !== 'object' || error === null) return 'unknown';
  const parts = [
    'code' in error && typeof error.code === 'string' ? error.code : null,
    'responseCode' in error && typeof error.responseCode === 'number'
      ? String(error.responseCode)
      : null,
  ].filter((part): part is string => part !== null);
  return parts.length > 0 ? parts.join(' ') : 'unknown';
}
