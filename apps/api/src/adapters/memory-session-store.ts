import type {
  SessionStorePort,
  StoredSession,
} from '../ports/session-store.js';

/** Sessions in memory (tests). */
export class MemorySessionStore implements SessionStorePort {
  private readonly sessions = new Map<string, StoredSession>();

  async get(id: string): Promise<StoredSession | null> {
    return this.sessions.get(id) ?? null;
  }

  async put(session: StoredSession): Promise<void> {
    this.sessions.set(session.id, session);
  }

  async remove(id: string): Promise<void> {
    this.sessions.delete(id);
  }

  async removeFor(personId: string): Promise<number> {
    const mine = [...this.sessions.values()].filter(
      (s) => s.personId === personId,
    );
    for (const session of mine) this.sessions.delete(session.id);
    return mine.length;
  }
}
