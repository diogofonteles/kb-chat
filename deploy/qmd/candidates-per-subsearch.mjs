#!/usr/bin/env node
// KBC-120 (ADR 0036 §7, amendment): QMD 2.8.3 takes a fixed 20 hits per sub-search in
// `hybridQuery` and `structuredSearch` (dist/store.js), whatever `candidateLimit` the MCP
// `query` tool receives, so a viewer who sees a small share of a collection gets short pages.
// This patch makes each sub-search take `max(20, candidateLimit)` when the caller passes
// `candidateLimit`, and keeps the 20 when it does not (QMD's own CLI and defaults unchanged).
//
//   node deploy/qmd/candidates-per-subsearch.mjs <qmd package dir>
//
// Exact replacements with expected counts: any other text (a new QMD version, a changed line)
// stops with an error, so the image build fails instead of shipping an unpatched index.
// Running it twice is a no-op. Remove it when QMD sizes its sub-searches by itself.
import { readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const DEPTH = 'Math.max(20, options?.candidateLimit ?? 0)';

/** Each fixed-20 call of 2.8.3, once each: three in hybridQuery, two in structuredSearch. */
export const REPLACEMENTS = [
  'store.searchFTS(query, 20, collection)',
  'store.searchFTS(q.query, 20, collection)',
  'store.searchVec(vecQueries[i].text, embedModel, 20, collection, undefined, embedding)',
  'store.searchFTS(search.query, 20, coll)',
  'store.searchVec(vecSearches[i].query, embedModel, 20, coll, undefined, embedding)',
].map((before) => ({
  before,
  after: before.replace(', 20, ', `, ${DEPTH}, `),
}));

const countOf = (text, needle) => text.split(needle).length - 1;

/**
 * The patched store.js, or an error naming every call whose text is not exactly as expected.
 * `changed` is false when the source was already patched.
 */
export function patchStore(source) {
  const states = REPLACEMENTS.map(({ before, after }) => ({
    before,
    stock: countOf(source, before),
    patched: countOf(source, after),
  }));
  if (states.every((s) => s.stock === 0 && s.patched === 1))
    return { text: source, changed: false };
  const wrong = states.filter((s) => !(s.stock === 1 && s.patched === 0));
  if (wrong.length > 0)
    throw new Error(
      'QMD store.js is not the expected 2.8.3 text; nothing was changed:\n' +
        wrong
          .map(
            (s) =>
              `  ${s.before}: found ${s.stock} stock and ${s.patched} patched (expected 1 stock)`,
          )
          .join('\n'),
    );
  let text = source;
  for (const { before, after } of REPLACEMENTS)
    text = text.replace(before, after);
  return { text, changed: true };
}

/** Patches `<dir>/dist/store.js` in place (a new file renamed over it: no hard link is shared). */
export function patchPackage(dir) {
  const file = realpathSync(join(dir, 'dist', 'store.js'));
  const { text, changed } = patchStore(readFileSync(file, 'utf8'));
  if (changed) {
    const next = `${file}.kbc120`;
    writeFileSync(next, text);
    renameSync(next, file);
  }
  return { file, changed };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const dir = process.argv[2];
  if (!dir) {
    process.stderr.write(
      'usage: candidates-per-subsearch.mjs <qmd package dir>\n',
    );
    process.exit(2);
  }
  try {
    const { file, changed } = patchPackage(dir);
    process.stdout.write(
      `${changed ? 'patched' : 'already patched'}: ${file} (${REPLACEMENTS.length} sub-searches)\n`,
    );
  } catch (err) {
    process.stderr.write(
      `${err instanceof Error ? err.message : String(err)}\n`,
    );
    process.exit(1);
  }
}
