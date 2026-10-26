import type { FastifyBaseLogger } from 'fastify';
import { AppError } from '../../app-error.js';
import type { Notifier } from './notifier.js';
import type { PeopleService } from './people-service.js';
import type { StoredPerson } from './person.js';
import { SlidingWindows, type RateWindow } from './sliding-windows.js';

const MINUTE = 60_000;

/** KBC-026 BR-3: per invitee, 1 every 10 minutes and 5 a day; the invite itself counts. */
const INVITEE_WINDOWS: readonly RateWindow[] = [
  { max: 1, ms: 10 * MINUTE },
  { max: 5, ms: 24 * 60 * MINUTE },
];

export interface InvitationsDeps {
  readonly people: PeopleService;
  readonly notifier: Notifier;
  readonly now?: () => number;
}

/** The master's name on one line, else their e-mail (BR-2). */
const inviterName = (inviter: StoredPerson): string =>
  inviter.name.trim() || inviter.email;

/**
 * The invitation e-mail of "Pessoas e permissões" (KBC-026). A send never undoes the
 * invite: its outcome is recorded on the person and a failure goes to the log, without
 * the message (BR-4).
 */
export class Invitations {
  private readonly windows: SlidingWindows;

  constructor(private readonly deps: InvitationsDeps) {
    this.windows = new SlidingWindows({ now: deps.now });
  }

  /** Right after an invite: over the limit (a re-invite) only means no e-mail this time. */
  async afterInvite(
    person: StoredPerson,
    inviter: StoredPerson,
    log: FastifyBaseLogger,
  ): Promise<StoredPerson> {
    if (!this.take(person).allowed) {
      log.warn({ personId: person.id }, 'invitation email skipped: limit');
      return person;
    }
    return this.deliver(person, inviter, log);
  }

  /** "Reenviar convite": only to someone who has not signed in yet (BR-6). */
  async resend(
    id: string,
    inviter: StoredPerson,
    log: FastifyBaseLogger,
  ): Promise<StoredPerson> {
    const person = await this.deps.people.find(id);
    if (!person) throw new AppError('NOT_FOUND', 'Unknown person');
    if (person.lastLoginAt !== null)
      throw new AppError('VALIDATION_FAILED', 'This person already signed in');
    const decision = this.take(person);
    if (!decision.allowed)
      throw new AppError('RATE_LIMITED', 'Invitation sent too recently', {
        details: { retryAt: new Date(decision.retryAt).toISOString() },
      });
    return this.deliver(person, inviter, log);
  }

  private take(person: StoredPerson) {
    return this.windows.take([{ key: person.email, windows: INVITEE_WINDOWS }]);
  }

  private async deliver(
    person: StoredPerson,
    inviter: StoredPerson,
    log: FastifyBaseLogger,
  ): Promise<StoredPerson> {
    const at = new Date(this.deps.now?.() ?? Date.now()).toISOString();
    try {
      await this.deps.notifier.invitation(person.email, inviterName(inviter));
    } catch (err: unknown) {
      // The provider's error is already free of the message and secrets (ADR 0012).
      log.error({ err, personId: person.id }, 'invitation email failed');
      return this.deps.people.recordInvitation(person.id, {
        sentAt: person.invitation?.sentAt ?? null,
        failedAt: at,
      });
    }
    return this.deps.people.recordInvitation(person.id, {
      sentAt: at,
      failedAt: null,
    });
  }
}
