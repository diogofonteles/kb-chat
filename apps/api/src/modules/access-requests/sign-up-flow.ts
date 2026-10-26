import { signUpRequestSchema } from '@kb-chat/contracts';
import { z } from 'zod';
import { AppError } from '../../app-error.js';
import type {
  Notifier,
  OneTimeCodes,
  PeopleService,
  TicketIdentity,
} from '../auth/index.js';
import type { AccessRequestService } from './access-request-service.js';
import type { StoredRequest } from './request-rules.js';

/** The confirmed sign-up form, kept with its code until the email is confirmed. */
const signUpPayloadSchema = z.object({
  email: z.email(),
  firstName: z.string(),
  lastName: z.string(),
  phone: z.string(),
});
export type SignUpForm = z.output<typeof signUpRequestSchema>;

export interface SignUpFlowDeps {
  readonly requests: AccessRequestService;
  readonly people: PeopleService;
  readonly codes: OneTimeCodes;
  readonly notifier: Notifier;
}

const splitName = (name: string) => {
  const [firstName = '', ...rest] = name.trim().split(/\s+/);
  return { firstName, lastName: rest.join(' ') };
};

/**
 * How a request is born (KBC-014): the form after its email code (BR-2), or a not-invited
 * Google identity through its ticket (FR-3). Masters hear of each new one.
 */
export class SignUpFlow {
  constructor(private readonly deps: SignUpFlowDeps) {}

  /** Runs after the 202: a code when the email can be used, a notice otherwise (BR-3). */
  async start(form: SignUpForm): Promise<void> {
    const email = form.email.toLowerCase();
    const { notifier } = this.deps;
    if (await this.deps.people.findByIdentifier(email))
      return notifier.alreadyHasAccess(email);
    const state = await this.deps.requests.stateFor({ email });
    if (state.status === 'pending') return notifier.requestPending(email);
    if (state.status === 'refused')
      return notifier.requestCooldown(email, state.retryAt);
    const value = await this.deps.codes.issue(
      { purpose: 'signup', identifier: email },
      { channel: 'email', payload: { ...form, email } },
    );
    await notifier.sendCode(
      { channel: 'email', address: email },
      { purpose: 'signup', value },
    );
  }

  /** The right code turns the form into a pending request. */
  async confirm(email: string, code: string): Promise<StoredRequest> {
    const entry = await this.deps.codes.verify(
      { purpose: 'signup', identifier: email.toLowerCase() },
      code,
    );
    const form = signUpPayloadSchema.safeParse(entry?.payload);
    if (!form.success)
      throw new AppError('INVALID_CODE', 'The code is wrong or expired');
    await this.assertNoAccess(form.data.email, null);
    return this.deps.requests.create({
      ...form.data,
      source: 'form',
      sub: null,
      picture: null,
    });
  }

  /** A verified Google identity asks for access with its ticket. */
  async fromGoogle(
    identity: TicketIdentity,
    phone: string | null,
  ): Promise<StoredRequest> {
    await this.assertNoAccess(identity.email, identity.sub);
    return this.deps.requests.create({
      email: identity.email,
      ...splitName(identity.name),
      phone,
      source: 'google',
      sub: identity.sub,
      picture: identity.picture,
    });
  }

  /** Masters get an email for each new request (they decide in Pessoas e permissões). */
  async tellMasters(request: StoredRequest): Promise<void> {
    const masters = await this.deps.people.masterEmails();
    await this.deps.notifier.newRequest(masters, request);
  }

  /** Someone who proved the address may hear that it already has access. */
  private async assertNoAccess(email: string, sub: string | null) {
    const people = await this.deps.people.list();
    if (
      people.some((p) => p.email === email || (sub !== null && p.sub === sub))
    )
      throw new AppError('ALREADY_INVITED', 'This e-mail already has access');
  }
}
