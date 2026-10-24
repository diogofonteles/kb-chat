import { readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import type {
  SessionStorePort,
  StoredSession,
} from '../ports/session-store.js';
import { isMissingFile, readJsonFile, writeJsonFile } from './atomic-json.js';

const SESSION_ID = /^[a-f0-9]{64}$/;

const storedSessionSchema = z.object({
  id: z.string().regex(SESSION_ID),
  personId: z.string().min(1),
  createdAt: z.iso.datetime(),
  expiresAt: z.iso.datetime(),
  refreshedAt: z.iso.datetime(),
});

/**
 * `<state>/sessions/<sha256>.json`, one 0600 file per session. Ids are checked as hex
 * hashes before touching the disk, so no cookie can name a path outside the folder.
 */
export class FsSessionStore implements SessionStorePort {
  constructor(private readonly dir: string) {}

  async get(id: string): Promise<StoredSession | null> {
    if (!SESSION_ID.test(id)) return null;
    const parsed = storedSessionSchema.safeParse(
      await readJsonFile(this.fileOf(id)).catch(() => null),
    );
    return parsed.success && parsed.data.id === id ? parsed.data : null;
  }

  put(session: StoredSession): Promise<void> {
    return writeJsonFile(this.fileOf(session.id), session);
  }

  async remove(id: string): Promise<void> {
    if (SESSION_ID.test(id)) await rm(this.fileOf(id), { force: true });
  }

  async removeFor(personId: string): Promise<number> {
    const ids = await this.ids();
    const sessions = await Promise.all(ids.map((id) => this.get(id)));
    const mine = sessions.filter((s) => s?.personId === personId);
    await Promise.all(mine.map((s) => s && this.remove(s.id)));
    return mine.length;
  }

  private async ids(): Promise<string[]> {
    const names = await readdir(this.dir).catch((err: unknown) => {
      if (isMissingFile(err)) return [];
      throw err;
    });
    return names
      .filter((name) => name.endsWith('.json'))
      .map((name) => name.slice(0, -'.json'.length))
      .filter((id) => SESSION_ID.test(id));
  }

  private fileOf(id: string): string {
    return join(this.dir, `${id}.json`);
  }
}
