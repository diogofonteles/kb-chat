import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const HEAVY = fileURLToPath(new URL('../heavy.sh', import.meta.url));

/** A lock of its own, with the variables of the run that calls these tests cleared. */
function queue(extra = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'kbc-heavy-'));
  const env = {
    ...process.env,
    KBC_HEAVY_LOCK: join(dir, 'heavy.lock'),
    KBC_HEAVY_MAX_LOAD: '100000',
    KBC_HEAVY_POLL: '0.05',
    ...extra,
  };
  delete env['CI'];
  delete env['KBC_HEAVY_HELD'];
  delete env['KBC_HEAVY_SKIP'];
  return { dir, env, lock: env.KBC_HEAVY_LOCK };
}

const run = (env, ...command) =>
  spawnSync(HEAVY, command, { env, encoding: 'utf8' });

function start(env, ...command) {
  const child = spawn(HEAVY, command, {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (data) => (output += data));
  child.stderr.on('data', (data) => (output += data));
  const done = new Promise((resolve) =>
    child.on('close', (code) => resolve({ code, output })),
  );
  return { child, done };
}

const until = async (condition) => {
  while (!condition()) await new Promise((r) => setTimeout(r, 20));
};

test('runs the command, says what it waited and passes its exit code on', () => {
  const { env, lock } = queue();
  const ok = run(env, 'sh', '-c', 'echo inside');
  assert.equal(ok.status, 0);
  assert.match(ok.stdout, /heavy: waited \d+ s; running: sh -c/);
  assert.match(ok.stdout, /inside/);
  assert.equal(run(env, 'sh', '-c', 'exit 7').status, 7);
  assert.equal(existsSync(lock), false);
});

test('without a command it refuses', () => {
  assert.equal(run(queue().env).status, 64);
});

test('two commands never overlap, from any folder', async () => {
  const { dir, env, lock } = queue();
  const log = join(dir, 'log');
  const step = (name) =>
    `echo ${name} in >> ${log}; sleep 0.3; echo ${name} out >> ${log}`;
  const first = start(env, 'sh', '-c', step('a'));
  await until(() => existsSync(join(lock, 'owner')));
  const second = start(env, 'sh', '-c', step('b'));
  const [a, b] = await Promise.all([first.done, second.done]);
  assert.equal(a.code, 0);
  assert.equal(b.code, 0);
  assert.match(b.output, /heavy: waiting \d+ s for: sh -c/);
  const lines = spawnSync('cat', [log], { encoding: 'utf8' }).stdout;
  assert.deepEqual(lines.trim().split('\n'), [
    'a in',
    'a out',
    'b in',
    'b out',
  ]);
});

test('a command already in the queue passes through', () => {
  const { env } = queue();
  const nested = run(env, HEAVY, 'sh', '-c', 'echo nested');
  assert.equal(nested.status, 0);
  assert.match(nested.stdout, /nested/);
});

test('CI and KBC_HEAVY_SKIP skip the queue, even with the lock taken', () => {
  for (const skip of [{ CI: 'true' }, { KBC_HEAVY_SKIP: '1' }]) {
    const { env, lock } = queue();
    mkdirSync(lock);
    writeFileSync(join(lock, 'owner'), `${process.pid}\n/\nother\n`);
    const result = run({ ...env, ...skip }, 'echo', 'skipped');
    assert.equal(result.status, 0);
    assert.equal(result.stdout, 'skipped\n');
  }
});

test('the lock of a process that died is taken over', () => {
  const { env, lock } = queue();
  const dead = spawnSync('sh', ['-c', 'echo $$'], { encoding: 'utf8' }).stdout;
  mkdirSync(lock);
  writeFileSync(join(lock, 'owner'), `${dead.trim()}\n/\nold run\n`);
  const result = run(env, 'echo', 'mine');
  assert.equal(result.status, 0);
  assert.match(result.stdout, /process that died: old run/);
  assert.match(result.stdout, /mine/);
});

test('a stopped run releases the lock and stops its command', async () => {
  const { env, lock } = queue();
  const running = start(env, 'sleep', '30');
  await until(() => existsSync(join(lock, 'owner')));
  await new Promise((r) => setTimeout(r, 200));
  running.child.kill('SIGTERM');
  const { code } = await running.done;
  assert.equal(code, 143);
  assert.equal(existsSync(lock), false);
});

test('waits for the load, and only so long', () => {
  const { env } = queue({ KBC_HEAVY_MAX_LOAD: '0', KBC_HEAVY_LOAD_WAIT: '0' });
  const result = run(env, 'echo', 'went');
  assert.equal(result.status, 0);
  assert.match(result.stdout, /stayed above 0 for 0 s; going ahead/);
  assert.match(result.stdout, /went/);
});
