import { createHash, randomBytes } from 'node:crypto';
import {
  chmod,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import type { SettingsStorePort } from '../ports/settings-store.js';

const isMissing = (err: unknown): boolean =>
  err instanceof Error && 'code' in err && err.code === 'ENOENT';

const SAFE_NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/;

/** A principal id as a file name: kept when plain ("owner"), hashed otherwise (e-mails, ids). */
export const settingsFileName = (principal: string): string =>
  SAFE_NAME.test(principal)
    ? `${principal}.json`
    : `${createHash('sha256').update(principal).digest('hex').slice(0, 32)}.json`;

/**
 * `<state>/settings/<principal>.json` (BR-1): owner-only permissions (0600, folder 0700) and
 * an atomic write (temporary file + rename), so a crash never leaves half a file.
 */
export class JsonSettingsStore implements SettingsStorePort {
  constructor(private readonly folder: string) {}

  fileOf(principal: string): string {
    return join(this.folder, settingsFileName(principal));
  }

  async read(principal: string): Promise<unknown> {
    try {
      return JSON.parse(await readFile(this.fileOf(principal), 'utf8'));
    } catch (err) {
      if (isMissing(err)) return null;
      throw err;
    }
  }

  async write(principal: string, value: object): Promise<void> {
    await mkdir(this.folder, { recursive: true, mode: 0o700 });
    const file = this.fileOf(principal);
    const temp = `${file}.${randomBytes(6).toString('hex')}.tmp`;
    try {
      await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, {
        mode: 0o600,
      });
      // The mode above is filtered by the umask; chmod makes 0600 exact.
      await chmod(temp, 0o600);
      await rename(temp, file);
    } catch (err) {
      await rm(temp, { force: true });
      throw err;
    }
  }
}
