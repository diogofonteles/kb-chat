import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { nodeProblem } from '../check-node.mjs';

const SCRIPT = fileURLToPath(new URL('../check-node.mjs', import.meta.url));
const WANTED = readFileSync(new URL('../../.nvmrc', import.meta.url), 'utf8');

test('a Node whose SQLite has FTS5 passes', () => {
  assert.equal(
    nodeProblem({
      version: '22.23.2',
      compileOptions: ['ENABLE_FTS5', 'THREADSAFE=1'],
      wanted: '22.23.2',
    }),
    null,
  );
});

test('a Node whose SQLite lacks FTS5 names itself and the Node to use', () => {
  const problem = nodeProblem({
    version: '22.13.0',
    compileOptions: ['THREADSAFE=1'],
    wanted: '22.23.2',
  });
  assert.match(problem, /Node 22\.13\.0 has SQLite without FTS5/);
  assert.match(problem, /Use Node 22\.23\.2 \(\.nvmrc\)/);
});

test('a Node with no node:sqlite at all names the Node to use', () => {
  const problem = nodeProblem({
    version: '20.18.1',
    compileOptions: null,
    wanted: '22.23.2',
  });
  assert.match(problem, /Node 20\.18\.1 has no node:sqlite/);
  assert.match(problem, /Use Node 22\.23\.2/);
});

test('.nvmrc pins an exact version', () => {
  assert.match(WANTED.trim(), /^\d+\.\d+\.\d+$/);
});

test('the Node running these tests passes the script', () => {
  const run = spawnSync(process.execPath, ['--no-warnings', SCRIPT], {
    encoding: 'utf8',
  });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stderr, '');
});
