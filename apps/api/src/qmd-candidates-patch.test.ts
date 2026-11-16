import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  REPLACEMENTS,
  patchStore,
} from '../../../deploy/qmd/candidates-per-subsearch.mjs';

const SCRIPT = fileURLToPath(
  new URL('../../../deploy/qmd/candidates-per-subsearch.mjs', import.meta.url),
);

/** The lines of @tobilu/qmd 2.8.3 dist/store.js the patch touches, verbatim (4341–4736). */
const STORE_283 = [
  'export async function hybridQuery(store, query, options) {',
  '    const candidateLimit = options?.candidateLimit ?? RERANK_CANDIDATE_LIMIT;',
  '    const initialFts = store.searchFTS(query, 20, collection);',
  '            const ftsResults = store.searchFTS(q.query, 20, collection);',
  '            const vecResults = await store.searchVec(vecQueries[i].text, embedModel, 20, collection, undefined, embedding);',
  '}',
  'export async function structuredSearch(store, searches, options) {',
  '    const candidateLimit = options?.candidateLimit ?? RERANK_CANDIDATE_LIMIT;',
  '                const ftsResults = store.searchFTS(search.query, 20, coll);',
  '                    const vecResults = await store.searchVec(vecSearches[i].query, embedModel, 20, coll, undefined, embedding);',
  '}',
  '',
].join('\n');

const packageWith = (store: string): string => {
  const dir = mkdtempSync(join(tmpdir(), 'kbc-qmd-patch-'));
  mkdirSync(join(dir, 'dist'));
  writeFileSync(join(dir, 'dist', 'store.js'), store);
  return dir;
};
const run = (dir: string) =>
  spawnSync(process.execPath, [SCRIPT, dir], { encoding: 'utf8' });

describe('the QMD candidates-per-sub-search patch (KBC-120)', () => {
  it('sizes every fixed-20 sub-search of 2.8.3 by candidateLimit', () => {
    const { text, changed } = patchStore(STORE_283);
    expect(changed).toBe(true);
    expect(text).not.toMatch(/searchFTS\([^)]*, 20, /);
    expect(text).not.toMatch(/searchVec\([^)]*, 20, /);
    expect(
      text.split('Math.max(20, options?.candidateLimit ?? 0)'),
    ).toHaveLength(REPLACEMENTS.length + 1);
  });

  it('keeps 20 when no candidateLimit is passed and never goes below it', () => {
    const [first] = REPLACEMENTS;
    const depth = new Function(
      'store',
      'query',
      'collection',
      'options',
      `return ${first?.after ?? ''};`,
    ) as (...args: unknown[]) => number;
    const store = { searchFTS: (_q: string, limit: number) => limit };
    expect(depth(store, 'q', 'c', undefined)).toBe(20);
    expect(depth(store, 'q', 'c', {})).toBe(20);
    expect(depth(store, 'q', 'c', { candidateLimit: 5 })).toBe(20);
    expect(depth(store, 'q', 'c', { candidateLimit: 300 })).toBe(300);
  });

  it('is a no-op on an already patched file', () => {
    const once = patchStore(STORE_283).text;
    expect(patchStore(once)).toEqual({ text: once, changed: false });
  });

  it('refuses a text that differs from 2.8.3, naming the call', () => {
    const changed = STORE_283.replace(
      'store.searchFTS(search.query, 20, coll)',
      'store.searchFTS(search.query, limit, coll)',
    );
    expect(() => patchStore(changed)).toThrow(
      /store\.searchFTS\(search\.query, 20, coll\): found 0 stock/,
    );
    const twice = `${STORE_283}${REPLACEMENTS[0]?.before ?? ''}\n`;
    expect(() => patchStore(twice)).toThrow(/found 2 stock/);
  });

  it('refuses a half-patched file', () => {
    const half = STORE_283.replace(
      REPLACEMENTS[0]?.before ?? '',
      REPLACEMENTS[0]?.after ?? '',
    );
    expect(() => patchStore(half)).toThrow(/found 0 stock and 1 patched/);
  });

  it('patches a package in place from the command line, once, and fails loudly otherwise', () => {
    const dir = packageWith(STORE_283);
    const store = join(dir, 'dist', 'store.js');
    const first = run(dir);
    expect(first.status).toBe(0);
    expect(first.stdout).toMatch(/^patched: .*store\.js \(5 sub-searches\)/);
    expect(readFileSync(store, 'utf8')).toBe(patchStore(STORE_283).text);
    const again = run(dir);
    expect(again.status).toBe(0);
    expect(again.stdout).toMatch(/^already patched/);

    const other = packageWith(STORE_283.replaceAll(', 20, ', ', 30, '));
    const refused = run(other);
    expect(refused.status).toBe(1);
    expect(refused.stderr).toMatch(/not the expected 2\.8\.3 text/);
    expect(readFileSync(join(other, 'dist', 'store.js'), 'utf8')).toContain(
      ', 30, ',
    );
    expect(run(join(other, 'missing')).status).toBe(1);
    expect(spawnSync(process.execPath, [SCRIPT]).status).toBe(2);
  });
});
