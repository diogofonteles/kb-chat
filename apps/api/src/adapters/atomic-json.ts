import { randomBytes } from 'node:crypto';
import {
  chmod,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { dirname } from 'node:path';

export const isMissingFile = (err: unknown): boolean =>
  err instanceof Error && 'code' in err && err.code === 'ENOENT';

/** The parsed JSON file, or null when it does not exist. */
export async function readJsonFile(file: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch (err) {
    if (isMissingFile(err)) return null;
    throw err;
  }
}

/**
 * Owner-only (0600, folder 0700) and atomic (temporary file + rename), so a crash never
 * leaves half a file. Holds keys, people and sessions.
 */
export async function writeJsonFile(
  file: string,
  value: object,
): Promise<void> {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
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
