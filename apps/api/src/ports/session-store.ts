/** A server-side session (ADR 0008); `id` is the SHA-256 of the cookie token, never the token. */
export interface StoredSession {
  readonly id: string;
  readonly personId: string;
  readonly createdAt: string;
  /** Sliding: pushed forward as the session is used. */
  readonly expiresAt: string;
  readonly refreshedAt: string;
}

/** Sessions under `<state>/sessions/` (one 0600 file each) or in memory (tests). */
export interface SessionStorePort {
  get(id: string): Promise<StoredSession | null>;
  put(session: StoredSession): Promise<void>;
  remove(id: string): Promise<void>;
  /** Deletes every session of a person (revocation, BR-4); returns how many. */
  removeFor(personId: string): Promise<number>;
}
