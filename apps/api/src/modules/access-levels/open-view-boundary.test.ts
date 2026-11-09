import { readFile, readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SRC = fileURLToPath(new URL('../..', import.meta.url));

/**
 * Where the open view may be named (ADR 0036 §7, §12): the module that defines it, and the
 * research tools, which stay open until KBC-104 because research in a collection with levels
 * is closed to members (LEVELS_PENDING) and masters see every level.
 */
const ALLOWED = new Set([
  'modules/access-levels/level-view.ts',
  'modules/access-levels/content-gate.ts',
  'modules/access-levels/index.ts',
  'modules/research/tools.ts',
  // A latency bench over a collection without levels, never a route.
  'scripts/search-tracks-latency.ts',
]);

async function sources(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.ts'))
    .filter((entry) => !/\.(test|bench)\.ts$/.test(entry.name))
    .map((entry) => join(entry.parentPath, entry.name));
}

describe('The open view stays where it is decided (KBC-103 review, ADR 0036 §12)', () => {
  it('no other source names OPEN_VIEW: a new content path must ask the gate for a view', async () => {
    const offenders: string[] = [];
    for (const file of await sources(SRC)) {
      const path = relative(SRC, file).split('\\').join('/');
      if (ALLOWED.has(path)) continue;
      if ((await readFile(file, 'utf8')).includes('OPEN_VIEW'))
        offenders.push(path);
    }
    expect(offenders).toEqual([]);
  });
});
