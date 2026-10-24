import { createHash } from 'node:crypto';
import { join } from 'node:path';
import type { SettingsStorePort } from '../ports/settings-store.js';
import { readJsonFile, writeJsonFile } from './atomic-json.js';

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

  read(principal: string): Promise<unknown> {
    return readJsonFile(this.fileOf(principal));
  }

  write(principal: string, value: object): Promise<void> {
    return writeJsonFile(this.fileOf(principal), value);
  }
}
