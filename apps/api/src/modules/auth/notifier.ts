import type { CodeChannel } from '@kb-chat/contracts';
import type { FastifyBaseLogger } from 'fastify';
import type { EmailSenderPort } from '../../ports/email-sender.js';
import type { SmsSenderPort } from '../../ports/sms-sender.js';
import * as messages from './messages.js';
import type { CodePurpose } from './one-time-codes.js';

export interface NotifierDeps {
  readonly email: EmailSenderPort;
  /** Null while no SMS provider is configured (KBC-014 BR-9). */
  readonly sms: SmsSenderPort | null;
  /** WEB_ORIGIN: where the emails send people. */
  readonly webOrigin: string;
}

/** Where a one-time code goes. */
export interface CodeDestination {
  readonly channel: CodeChannel;
  /** Email address or E.164 number. */
  readonly address: string;
}

/**
 * What kb-chat tells people by email or SMS (ADR 0011). Sends run after the reply, so a
 * failure is logged and never reaches the person who asked (no enumeration, BR-3).
 */
export class Notifier {
  constructor(private readonly deps: NotifierDeps) {}

  get smsEnabled(): boolean {
    return this.deps.sms !== null;
  }

  async sendCode(
    to: CodeDestination,
    code: { readonly purpose: CodePurpose; readonly value: string },
  ): Promise<void> {
    if (to.channel === 'sms') {
      if (!this.deps.sms) throw new Error('No SMS provider is configured');
      return this.deps.sms.send({
        to: to.address,
        text: messages.codeSms(code.value),
      });
    }
    return this.email(to.address, messages.codeEmail(code.purpose, code.value));
  }

  alreadyHasAccess(email: string): Promise<void> {
    return this.email(email, messages.alreadyHasAccess(this.deps.webOrigin));
  }

  requestPending(email: string): Promise<void> {
    return this.email(email, messages.requestPending());
  }

  requestCooldown(email: string, retryAt: string): Promise<void> {
    return this.email(email, messages.requestCooldown(retryAt));
  }

  async newRequest(
    masters: readonly string[],
    request: messages.RequestSummary,
  ): Promise<void> {
    const text = messages.newRequestForMasters(request, this.deps.webOrigin);
    await Promise.all(masters.map((to) => this.email(to, text)));
  }

  approved(email: string, firstName: string): Promise<void> {
    return this.email(email, messages.approved(firstName, this.deps.webOrigin));
  }

  /** The invitation e-mail (KBC-026); throws when the provider refuses, for the caller to record. */
  invitation(email: string, inviter: string): Promise<void> {
    return this.email(
      email,
      messages.invitation({ inviter, email, origin: this.deps.webOrigin }),
    );
  }

  private email(to: string, { subject, text }: messages.Text): Promise<void> {
    return this.deps.email.send({ to, subject, text });
  }
}

/**
 * Runs a delivery after the reply (BR-3, NFR-3): the answer never waits for it nor tells
 * whether it happened; a failure goes to the log only.
 */
export function deliverLater(
  log: FastifyBaseLogger,
  delivery: () => Promise<unknown>,
): void {
  setImmediate(() => {
    delivery().catch((err: unknown) => log.error({ err }, 'delivery failed'));
  });
}
