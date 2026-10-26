import { createHash, randomBytes } from 'node:crypto';
import type {
  SessionStorePort,
  StoredSession,
} from '../../ports/session-store.js';

const DAY_MS = 24 * 3600 * 1000;
/** Sliding expiry (ADR 0008). */
export const SESSION_TTL_MS = 30 * DAY_MS;
/** A used session is pushed forward at most once an hour (one write, not one per request). */
const REFRESH_EVERY_MS = 3600 * 1000;

export interface SessionServiceDeps {
  readonly store: SessionStorePort;
  readonly now?: () => Date;
}

/** Only the hash is stored: a copy of the sessions folder opens no session. */
export const sessionIdOf = (token: string): string =>
  createHash('sha256').update(token).digest('hex');

/** Opaque server-side sessions: a random 32-byte token in the cookie, its hash on disk. */
export class SessionService {
  constructor(private readonly deps: SessionServiceDeps) {}

  /** A new session; returns the token for the cookie. */
  async create(personId: string): Promise<string> {
    const token = randomBytes(32).toString('base64url');
    const now = this.now();
    await this.deps.store.put({
      id: sessionIdOf(token),
      personId,
      createdAt: now.toISOString(),
      refreshedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + SESSION_TTL_MS).toISOString(),
    });
    return token;
  }

  /** The live session of a token (refreshed when due), or null. */
  async resolve(token: string): Promise<StoredSession | null> {
    const session = await this.deps.store.get(sessionIdOf(token));
    if (!session) return null;
    const now = this.now().getTime();
    if (Date.parse(session.expiresAt) <= now) {
      await this.deps.store.remove(session.id);
      return null;
    }
    if (now - Date.parse(session.refreshedAt) < REFRESH_EVERY_MS)
      return session;
    const refreshed = {
      ...session,
      refreshedAt: new Date(now).toISOString(),
      expiresAt: new Date(now + SESSION_TTL_MS).toISOString(),
    };
    await this.deps.store.put(refreshed);
    return refreshed;
  }

  destroy(token: string): Promise<void> {
    return this.deps.store.remove(sessionIdOf(token));
  }

  /** Revocation (BR-4): every open session of the person ends now. */
  destroyFor(personId: string): Promise<number> {
    return this.deps.store.removeFor(personId);
  }

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }
}
