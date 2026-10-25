import {
  createHmac,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from 'node:crypto';
import { z } from 'zod';
import { AppError } from '../../app-error.js';

/** How long "Solicitar acesso" stays possible after a not-invited Google sign-in (ADR 0011). */
export const REQUEST_TICKET_TTL_MS = 15 * 60_000;

/** The verified Google identity a ticket carries. */
export interface TicketIdentity {
  readonly sub: string;
  readonly email: string;
  readonly name: string;
  readonly picture: string | null;
}

const payloadSchema = z.object({
  jti: z.string(),
  sub: z.string().min(1),
  email: z.email(),
  name: z.string(),
  picture: z.string().nullable(),
  exp: z.number(),
});

const expired = (): AppError =>
  new AppError('REQUEST_EXPIRED', 'The access request ticket is not valid');

/**
 * Signed, short-lived and single-use tickets (ADR 0011): the not-invited Google identity
 * becomes a request without accepting the same ID token twice (ADR 0008). The key is made
 * at boot and kept in memory, so a restart only means signing in with Google again.
 */
export class RequestTickets {
  private readonly key = randomBytes(32);
  /** Spent ticket ids → their expiry (ms). */
  private readonly spent = new Map<string, number>();

  constructor(private readonly options: { readonly now?: () => number } = {}) {}

  issue(identity: TicketIdentity): string {
    const payload = {
      jti: randomUUID(),
      sub: identity.sub,
      email: identity.email,
      name: identity.name,
      picture: identity.picture,
      exp: this.now() + REQUEST_TICKET_TTL_MS,
    };
    const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
    return `${body}.${this.sign(body)}`;
  }

  /** The identity of a valid ticket, spending it; REQUEST_EXPIRED otherwise. */
  redeem(ticket: string): TicketIdentity {
    const payload = this.verified(ticket);
    const now = this.now();
    for (const [jti, exp] of this.spent) if (exp <= now) this.spent.delete(jti);
    if (payload.exp <= now || this.spent.has(payload.jti)) throw expired();
    this.spent.set(payload.jti, payload.exp);
    const { sub, email, name, picture } = payload;
    return { sub, email, name, picture };
  }

  private verified(ticket: string): z.infer<typeof payloadSchema> {
    const [body, signature, extra] = ticket.split('.');
    if (!body || !signature || extra !== undefined) throw expired();
    const expected = Buffer.from(this.sign(body));
    const actual = Buffer.from(signature);
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual))
      throw expired();
    const parsed = payloadSchema.safeParse(
      JSON.parse(Buffer.from(body, 'base64url').toString('utf8')),
    );
    if (!parsed.success) throw expired();
    return parsed.data;
  }

  private sign(body: string): string {
    return createHmac('sha256', this.key).update(body).digest('base64url');
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }
}
