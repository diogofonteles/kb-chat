import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const RETRY = fileURLToPath(new URL('retry.sh', import.meta.url));

const run = (...args) => spawnSync(RETRY, args, { encoding: 'utf8' });

test('stops at the first success and passes the command through', () => {
  const result = run('3', '5', 'echo', 'done');
  assert.equal(result.status, 0);
  assert.equal(result.stdout.trim(), 'done');
});

test('a hung attempt is killed at its limit and the next one succeeds', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'kbc-retry-'));
  t.after(() => rmSync(dir, { recursive: true }));
  const marker = join(dir, 'tries');
  writeFileSync(marker, '');
  const script = `echo x >> ${marker}; [ "$(wc -l < ${marker})" -gt 1 ] || sleep 30`;
  const started = Date.now();
  const result = run('3', '1', 'sh', '-c', script);
  assert.equal(result.status, 0);
  assert.equal(readFileSync(marker, 'utf8').trim().split('\n').length, 2);
  assert.ok(Date.now() - started < 10_000);
  assert.match(result.stdout, /attempt 1 of 3/);
});

test('gives up after the last attempt with the command status', () => {
  const result = run('2', '5', 'sh', '-c', 'exit 7');
  assert.equal(result.status, 7);
  assert.match(result.stdout, /attempt 2 of 2/);
});
