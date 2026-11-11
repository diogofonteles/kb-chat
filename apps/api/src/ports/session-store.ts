/** A server-side session (ADR 0008); `id` is the SHA-256 of the cookie token, never the token. */
export interface StoredSession {
  readonly id: string;
  readonly personId: string;
  readonly createdAt: string;
  /** Sliding: pushed forward as the session is used. */
  readonly expiresAt: string;
  readonly refreshedAt: string;
  /** A master acting as a person (KBC-060): whose view every request takes. */
  readonly actingAs?: StoredActing;
}

/** What a session keeps while its master acts as a person (ADR 0027). */
export interface StoredActing {
  /** This acting session, shared by its audit lines. */
  readonly id?: string;
  readonly personId: string;
  /** Who the person was when it started (kept for the audit if they are removed). */
  readonly personName?: string;
  readonly personEmail?: string;
  readonly reason: string;
  readonly startedAt: string;
  readonly endsAt: string;
}

/** Sessions under `<state>/sessions/` (one 0600 file each) or in memory (tests). */
export interface SessionStorePort {
  get(id: string): Promise<StoredSession | null>;
  put(session: StoredSession): Promise<void>;
  remove(id: string): Promise<void>;
  /** Deletes every session of a person (revocation, BR-4); returns how many. */
  removeFor(personId: string): Promise<number>;
}
