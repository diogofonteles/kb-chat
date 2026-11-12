import { existsSync, readdirSync, rmSync } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * The temporary names a file copy goes through (`.<ms>.importing`, then a rename): one left
 * behind is a copy a crash cut short (QA F-3). The check lists them; a real run removes them
 * before it starts, since no other run can be copying (the API is stopped, the deploy lock
 * is held).
 */
export const TEMP_SUFFIX = '.importing';
const TEMP_NAME = /^\.\d+\.importing$/;

/** Media-relative paths of the copies cut short, under the folders the import writes. */
export function staleCopies(mediaDir: string): string[] {
  const found: string[] = [];
  for (const folder of ['audio', 'transcripts']) {
    const root = join(mediaDir, folder);
    if (!existsSync(root)) continue;
    const entries = readdirSync(root, { recursive: true, withFileTypes: true });
    found.push(
      ...entries
        .filter((entry) => entry.isFile() && TEMP_NAME.test(entry.name))
        .map((entry) => relative(mediaDir, join(entry.parentPath, entry.name))),
    );
  }
  return found.sort();
}

export function removeStaleCopies(mediaDir: string): void {
  for (const path of staleCopies(mediaDir))
    rmSync(join(mediaDir, path), { force: true });
}
