#!/usr/bin/env node
// The Node this repository needs, checked before a heavy run instead of after it: the media
// library's search is SQLite FTS5 (ADR 0024), and a Node whose SQLite lacks it (22.13, say)
// only fails once the E2E server or the media tests open the database, after the queue.
//
//   node --no-warnings tools/check-node.mjs    exit 0, or the reason and the Node to use
//
// The Node to use is the one in .nvmrc.

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const NVMRC = new URL('../.nvmrc', import.meta.url);

/** The SQLite compile options of this Node, or null when it has no `node:sqlite`. */
export function sqliteCompileOptions() {
  let DatabaseSync;
  try {
    ({ DatabaseSync } = createRequire(import.meta.url)('node:sqlite'));
  } catch {
    return null;
  }
  const db = new DatabaseSync(':memory:');
  try {
    return db
      .prepare('PRAGMA compile_options')
      .all()
      .map((row) => String(row['compile_options']));
  } finally {
    db.close();
  }
}

/** Why this Node cannot run the repository, or null when it can. */
export function nodeProblem({ version, compileOptions, wanted }) {
  const use = `Use Node ${wanted} (.nvmrc): \`nvm use\`, or put it first on PATH.`;
  if (compileOptions === null)
    return `Node ${version} has no node:sqlite, which the media library needs. ${use}`;
  if (!compileOptions.includes('ENABLE_FTS5'))
    return `Node ${version} has SQLite without FTS5, which the media library's search needs (ADR 0024). ${use}`;
  return null;
}

export function checkNode() {
  return nodeProblem({
    version: process.versions.node,
    compileOptions: sqliteCompileOptions(),
    wanted: readFileSync(NVMRC, 'utf8').trim(),
  });
}

/**
 * For a test config, before its servers start: exits with the reason when this Node cannot
 * run the repository. In a child, so `node:sqlite` warns nowhere in the caller.
 */
export function requireFittingNode() {
  const check = spawnSync(
    process.execPath,
    ['--no-warnings', fileURLToPath(import.meta.url)],
    { stdio: 'inherit' },
  );
  if (check.status !== 0) process.exit(check.status ?? 1);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const problem = checkNode();
  if (problem) {
    process.stderr.write(`kb-chat: ${problem}\n`);
    process.exit(1);
  }
}
