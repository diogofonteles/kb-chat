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

/**
 * Every way to make a view by hand: the open and closed constants, the scaled view's builder,
 * and a literal view (`seesAll: true` / an `allows` that admits all). Only the gate builds them.
 */
const VIEW_MAKERS: readonly RegExp[] = [
  /\bOPEN_VIEW\b/,
  /\bCLOSED_VIEW\b/,
  /\bscaledView\s*\(/,
  /seesAll\s*:\s*true/,
  /allows\s*:\s*\(\)\s*=>\s*true/,
];

/** Where only the gate's module may build a view (the rest of the list is the open view). */
const BUILDERS = new Set([
  'modules/access-levels/level-view.ts',
  'modules/access-levels/content-gate.ts',
  'modules/access-levels/index.ts',
]);

async function offendersOf(
  allowed: ReadonlySet<string>,
  patterns: readonly RegExp[],
): Promise<string[]> {
  const offenders: string[] = [];
  for (const file of await sources(SRC)) {
    const path = relative(SRC, file).split('\\').join('/');
    if (allowed.has(path)) continue;
    const text = await readFile(file, 'utf8');
    if (patterns.some((pattern) => pattern.test(text))) offenders.push(path);
  }
  return offenders;
}

describe('The open view stays where it is decided (KBC-103 review, ADR 0036 §12)', () => {
  it('no other source names OPEN_VIEW: a new content path must ask the gate for a view', async () => {
    expect(await offendersOf(ALLOWED, [/\bOPEN_VIEW\b/])).toEqual([]);
  });

  it('no source outside the gate builds a view another way (a literal, the builder, the closed one)', async () => {
    const rest = VIEW_MAKERS.filter((one) => one.source !== '\\bOPEN_VIEW\\b');
    expect(await offendersOf(BUILDERS, rest)).toEqual([]);
  });
});
