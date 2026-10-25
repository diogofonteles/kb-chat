/** A plain-text email (ADR 0011): one-time codes and access request notices, in pt-BR. */
export interface EmailMessage {
  readonly to: string;
  readonly subject: string;
  readonly text: string;
}

/** Resend in production; the API log in development; an outbox in tests and E2E. */
export interface EmailSenderPort {
  /** Throws when the provider refuses or does not answer. */
  send(message: EmailMessage): Promise<void>;
}
