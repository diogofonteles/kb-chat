import { createHash } from 'node:crypto';
import { errors, jwtVerify } from 'jose';
import { z } from 'zod';
import { AppError } from '../app-error.js';
import type {
  IdentityVerifierPort,
  VerifiedIdentity,
} from '../ports/identity-verifier.js';
import { JwksCache } from './jwks-cache.js';

/**
 * Google's ID token issuer and keys (ADR 0008). Fixed here: the production composition
 * cannot be pointed at another issuer by configuration; only the E2E server builds a
 * verifier over its own test keys.
 */
export const GOOGLE_IDENTITY = Object.freeze({
  jwksUrl: 'https://www.googleapis.com/oauth2/v3/certs',
  issuers: Object.freeze([
    'accounts.google.com',
    'https://accounts.google.com',
  ]),
});

/** Clock skew accepted on exp/iat. */
const CLOCK_TOLERANCE_S = 60;
/** Google ID tokens live for an hour. */
const MAX_TOKEN_AGE = '1h';

export interface IdTokenVerifierOptions {
  readonly clientId: string;
  readonly jwksUrl: string;
  readonly issuers: readonly string[];
  readonly fetch?: typeof fetch;
  /** Milliseconds; tests move the clock. */
  readonly now?: () => number;
  /** How long the keys download may take before sign-in answers AUTH_UNAVAILABLE. */
  readonly jwksTimeoutMs?: number;
}

const claimsSchema = z.object({
  sub: z.string().min(1).max(255),
  email: z.email(),
  // Older tokens carried the flag as a string.
  email_verified: z.union([z.boolean(), z.literal('true'), z.literal('false')]),
  exp: z.number(),
  name: z.string().max(200).optional(),
  picture: z.url().optional(),
});

const unauthenticated = (cause: unknown): AppError =>
  new AppError('UNAUTHENTICATED', 'Invalid Google credential', { cause });

/**
 * Verifies a Google Identity Services credential: RS256, aud, iss, exp/iat, email. Each
 * credential opens one session only: a replayed one is refused until it expires.
 */
export class GoogleIdTokenVerifier implements IdentityVerifierPort {
  private readonly jwks: JwksCache;
  /** SHA-256 of each accepted credential → its expiry (ms). */
  private readonly used = new Map<string, number>();

  constructor(private readonly options: IdTokenVerifierOptions) {
    this.jwks = new JwksCache({
      url: options.jwksUrl,
      fetch: options.fetch,
      now: options.now,
      timeoutMs: options.jwksTimeoutMs,
    });
  }

  async verify(credential: string): Promise<VerifiedIdentity> {
    const payload = await this.verifiedPayload(credential);
    const claims = claimsSchema.safeParse(payload);
    if (!claims.success) throw unauthenticated(claims.error);
    this.useOnce(credential, claims.data.exp);
    const { sub, email, name, picture } = claims.data;
    const verified = String(claims.data.email_verified) === 'true';
    return {
      sub,
      email: email.toLowerCase(),
      emailVerified: verified,
      name: name ?? email,
      picture: picture ?? null,
    };
  }

  private useOnce(credential: string, expS: number): void {
    const now = this.options.now?.() ?? Date.now();
    for (const [key, expiry] of this.used)
      if (expiry <= now) this.used.delete(key);
    const key = createHash('sha256').update(credential).digest('hex');
    if (this.used.has(key))
      throw unauthenticated(new Error('credential already used'));
    this.used.set(key, (expS + CLOCK_TOLERANCE_S) * 1000);
  }

  private async verifiedPayload(credential: string): Promise<unknown> {
    const { clientId, issuers, now } = this.options;
    try {
      const { payload } = await jwtVerify(credential, this.jwks.getKey, {
        algorithms: ['RS256'],
        audience: clientId,
        issuer: [...issuers],
        clockTolerance: CLOCK_TOLERANCE_S,
        maxTokenAge: MAX_TOKEN_AGE,
        requiredClaims: ['sub', 'exp', 'iat'],
        ...(now && { currentDate: new Date(now()) }),
      });
      return payload;
    } catch (err) {
      if (err instanceof errors.JOSEError) throw unauthenticated(err);
      throw new AppError('AUTH_UNAVAILABLE', 'Cannot reach the sign-in keys', {
        cause: err,
      });
    }
  }
}

/** The production verifier: Google's issuer and keys, the configured client id. */
export const createGoogleVerifier = (
  clientId: string,
  fetchImpl?: typeof fetch,
): GoogleIdTokenVerifier =>
  new GoogleIdTokenVerifier({
    clientId,
    jwksUrl: GOOGLE_IDENTITY.jwksUrl,
    issuers: GOOGLE_IDENTITY.issuers,
    fetch: fetchImpl,
  });
