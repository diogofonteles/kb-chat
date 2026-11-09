import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const HEAVY = fileURLToPath(new URL('../heavy.sh', import.meta.url));

const made = [];
after(() => made.forEach((dir) => rmSync(dir, { recursive: true })));

/** A lock and a temp base of its own, with the variables of the calling run cleared. */
function queue(extra = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'kbc-heavy-'));
  made.push(dir);
  const temp = join(dir, 'temp');
  const env = {
    ...process.env,
    KBC_HEAVY_LOCK: join(dir, 'heavy.lock'),
    KBC_HEAVY_MAX_LOAD: '100000',
    KBC_HEAVY_MIN_FREE_GB: '0',
    KBC_HEAVY_TEMP: temp,
    KBC_HEAVY_POLL: '0.05',
    ...extra,
  };
  delete env['CI'];
  delete env['KBC_HEAVY_HELD'];
  delete env['KBC_HEAVY_SKIP'];
  delete env['KBC_TEST_TEMP'];
  delete env['KBC_HEAVY_WORKERS'];
  delete env['VITEST_MAX_WORKERS'];
  return { dir, env, lock: env.KBC_HEAVY_LOCK, temp };
}

const roots = (temp) => (existsSync(temp) ? readdirSync(temp) : []);

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** A `df` that reports this many GB free, or fails without one. */
function fakeDf(gb) {
  const bin = mkdtempSync(join(tmpdir(), 'kbc-heavy-'));
  made.push(bin);
  const script =
    gb === undefined
      ? '#!/bin/sh\nexit 1\n'
      : `#!/bin/sh\necho header\necho "disk 0 0 ${gb * 1048576} 0% /"\n`;
  writeFileSync(join(bin, 'df'), script, { mode: 0o755 });
  return bin;
}

const deadPid = () =>
  spawnSync('sh', ['-c', 'echo $$'], { encoding: 'utf8' }).stdout.trim();

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

test('says the commit it runs on and whether the tree is clean', () => {
  const { dir, env } = queue();
  const repo = join(dir, 'repo');
  mkdirSync(repo);
  const git = (...args) =>
    spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
  git('init', '-q');
  git(
    '-c',
    'user.name=t',
    '-c',
    'user.email=t@t',
    'commit',
    '-q',
    '--allow-empty',
    '-m',
    'x',
  );
  const sha = git('rev-parse', 'HEAD').stdout.trim();
  const inRepo = (...command) =>
    spawnSync(HEAVY, command, { env, cwd: repo, encoding: 'utf8' });
  assert.match(
    inRepo('true').stdout,
    new RegExp(`heavy: at ${sha} \\(clean\\)`),
  );
  writeFileSync(join(repo, 'new.txt'), 'x');
  assert.match(
    inRepo('true').stdout,
    new RegExp(`heavy: at ${sha} \\(dirty: 1 changed path\\)`),
  );
  const outside = join(dir, 'outside');
  mkdirSync(outside);
  const bare = spawnSync(HEAVY, ['true'], {
    env: { ...env, GIT_CEILING_DIRECTORIES: dir },
    cwd: outside,
    encoding: 'utf8',
  });
  assert.equal(bare.status, 0);
  assert.match(bare.stdout, /heavy: at no commit \(not a git checkout\)/);
});

test('a Node command that exits right after a big write loses none of it to the pipe', () => {
  const { env } = queue();
  const bytes = 1_000_000;
  const result = spawnSync(
    HEAVY,
    [
      process.execPath,
      '-e',
      `process.stdout.write('x'.repeat(${bytes})); process.exit(0)`,
    ],
    { env, encoding: 'utf8', maxBuffer: 4 * bytes },
  );
  assert.equal(result.status, 0);
  assert.equal(result.stdout.match(/x{100,}/)?.[0].length, bytes);
});

test('KBC_HEAVY_ASYNC_STDIO=1 leaves the writes as Node makes them', () => {
  const { env } = queue({ KBC_HEAVY_ASYNC_STDIO: '1' });
  const result = spawnSync(
    HEAVY,
    [
      process.execPath,
      '-e',
      'process.stdout.write(process.env.NODE_OPTIONS ?? "")',
    ],
    { env: { ...env, NODE_OPTIONS: '' }, encoding: 'utf8' },
  );
  assert.equal(result.status, 0);
  assert.doesNotMatch(result.stdout, /blocking-stdio/);
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
  mkdirSync(lock);
  writeFileSync(join(lock, 'owner'), `${deadPid()}\n/\nold run\n`);
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

test('gives each vitest half the CPUs, a quarter when the load never fell', () => {
  const cpus = Number(
    spawnSync('getconf', ['_NPROCESSORS_ONLN'], { encoding: 'utf8' }).stdout,
  );
  const workers = (env) =>
    run(env, 'sh', '-c', 'echo "workers=$VITEST_MAX_WORKERS"').stdout;
  const calm = workers(queue().env);
  assert.match(
    calm,
    new RegExp(`workers=${Math.max(2, Math.floor(cpus / 2))}\n`),
  );
  assert.match(calm, /heavy: \d+ vitest workers per suite/);
  const busy = queue({ KBC_HEAVY_MAX_LOAD: '0', KBC_HEAVY_LOAD_WAIT: '0' });
  assert.match(
    workers(busy.env),
    new RegExp(`workers=${Math.max(2, Math.floor(cpus / 4))}\n`),
  );
});

test('a count of workers given is kept, VITEST_MAX_WORKERS first', () => {
  const { env } = queue();
  const workers = (extra) =>
    run({ ...env, ...extra }, 'sh', '-c', 'echo "workers=$VITEST_MAX_WORKERS"')
      .stdout;
  assert.match(workers({ KBC_HEAVY_WORKERS: '3' }), /workers=3\n/);
  assert.match(
    workers({ KBC_HEAVY_WORKERS: '3', VITEST_MAX_WORKERS: '5' }),
    /workers=5\n/,
  );
});

test('a run works in a temp root of its own, gone after success and failure', () => {
  const { dir, env, temp } = queue();
  const seen = join(dir, 'seen');
  const script = `echo "$TMPDIR|$KBC_TEST_TEMP|$MAC_CHROMIUM_TMPDIR|$NX_DAEMON" > ${seen}; touch "$TMPDIR/left"; exit`;
  for (const code of [0, 7]) {
    assert.equal(run(env, 'sh', '-c', `${script} ${code}`).status, code);
    const [root, marker, chrome, daemon] = readFileSync(seen, 'utf8')
      .trim()
      .split('|');
    assert.ok(root.startsWith(`${temp}/`));
    assert.equal(marker, root);
    assert.equal(chrome, root);
    assert.equal(daemon, 'false');
    assert.deepEqual(roots(temp), []);
  }
});

test('KBC_HEAVY_SKIP skips the queue, not the temp root', () => {
  const { env, temp } = queue();
  const skip = { ...env, KBC_HEAVY_SKIP: '1' };
  const result = run(skip, 'sh', '-c', 'echo "$TMPDIR"');
  assert.equal(result.status, 0);
  assert.ok(result.stdout.startsWith(`${temp}/`));
  assert.deepEqual(roots(temp), []);
});

test('CI and a nested command keep the temp they were given', () => {
  const { env, temp } = queue({ TMPDIR: '/given' });
  for (const inside of [{ CI: 'true' }, { KBC_HEAVY_HELD: '1' }]) {
    const result = run({ ...env, ...inside }, 'sh', '-c', 'echo "$TMPDIR"');
    assert.equal(result.stdout, '/given\n');
    assert.deepEqual(roots(temp), []);
  }
});

test('a stopped run takes its children and its temp root with it', async () => {
  const { dir, env, lock, temp } = queue();
  const pidFile = join(dir, 'pid');
  // A child that shrugs off SIGINT, in the background of a command that is gone first.
  const script = `(trap '' INT; sleep 30) & echo $! > ${pidFile}; wait`;
  const running = start(env, 'sh', '-c', script);
  await until(() => existsSync(pidFile) && readFileSync(pidFile, 'utf8'));
  const pid = Number(readFileSync(pidFile, 'utf8'));
  running.child.kill('SIGTERM');
  assert.equal((await running.done).code, 143);
  assert.equal(alive(pid), false);
  assert.deepEqual(roots(temp), []);
  assert.equal(existsSync(lock), false);
});

test('a stopped run also stops what left its process group', async () => {
  const { dir, env, temp } = queue();
  const pidFile = join(dir, 'pid');
  // A leader of its own group, as Playwright makes its web servers.
  const leader = `perl -e 'setpgrp(0, 0); exec "sleep", "30"'`;
  const script = `${leader} & echo $! > ${pidFile}; wait`;
  const running = start(env, 'sh', '-c', script);
  await until(() => existsSync(pidFile) && readFileSync(pidFile, 'utf8'));
  const pid = Number(readFileSync(pidFile, 'utf8'));
  await new Promise((r) => setTimeout(r, 200));
  running.child.kill('SIGTERM');
  assert.equal((await running.done).code, 143);
  assert.equal(alive(pid), false);
  assert.deepEqual(roots(temp), []);
});

test('a command that ignores its signals is killed, not waited for', async () => {
  const { dir, env, lock, temp } = queue();
  const ready = join(dir, 'ready');
  const script = `trap '' INT TERM HUP; touch ${ready}; while :; do sleep 0.1; done`;
  const running = start(env, 'sh', '-c', script);
  await until(() => existsSync(ready));
  running.child.kill('SIGTERM');
  assert.equal((await running.done).code, 143);
  assert.deepEqual(roots(temp), []);
  assert.equal(existsSync(lock), false);
});

test('what a finished command left running is stopped', async () => {
  const { dir, env, temp } = queue();
  const pidFile = join(dir, 'pid');
  const script = `sleep 30 & echo $! > ${pidFile}`;
  assert.equal(run(env, 'sh', '-c', script).status, 0);
  assert.equal(alive(Number(readFileSync(pidFile, 'utf8'))), false);
  assert.deepEqual(roots(temp), []);
});

test('the root of a killed run is swept by the next run', async () => {
  const { env, lock, temp } = queue();
  const killed = start(env, 'sleep', '0.5');
  await until(() => roots(temp).length === 1);
  killed.child.kill('SIGKILL');
  await killed.done;
  assert.equal(roots(temp).length, 1);
  rmSync(lock, { recursive: true });
  const result = run(env, 'echo', 'next');
  assert.match(result.stdout, /swept the temp of 1 dead runs/);
  assert.deepEqual(roots(temp), []);
});

test('the root of a run still alive is left alone, whoever sweeps', async () => {
  const { env, temp } = queue();
  const live = join(temp, `${process.pid}.live`);
  const dead = join(temp, `${deadPid()}.dead`);
  const foreign = join(temp, 'not-a-run');
  const numbered = deadPid();
  const number = join(temp, numbered);
  [live, dead, foreign, number].forEach((path) =>
    mkdirSync(path, { recursive: true }),
  );
  const skip = { ...env, KBC_HEAVY_SKIP: '1' };
  assert.match(run(skip, 'true').stdout, /swept the temp of 1 dead runs/);
  assert.deepEqual(
    roots(temp).sort(),
    [`${process.pid}.live`, 'not-a-run', numbered].sort(),
  );
});

test('refuses under the free-space floor, with a clear message and no root', () => {
  const { dir, env, lock, temp } = queue({
    KBC_HEAVY_MIN_FREE_GB: '999999999',
  });
  const marker = join(dir, 'ran');
  const result = run(env, 'touch', marker);
  assert.equal(result.status, 75);
  assert.match(result.stderr, /refusing to run: \d+ GB free/);
  assert.match(result.stderr, /needs 999999999 GB/);
  assert.equal(existsSync(marker), false);
  assert.equal(existsSync(lock), false);
  assert.deepEqual(roots(temp), []);
});

test('an unknown free space or a floor that is no number refuses', () => {
  const { env } = queue();
  const broken = { ...env, PATH: `${fakeDf()}:${env.PATH}` };
  assert.equal(run(broken, 'true').status, 75);
  assert.equal(
    run({ ...env, KBC_HEAVY_MIN_FREE_GB: 'abc' }, 'true').status,
    75,
  );
});

test('a command under a terminal can use it, and the terminal stops it', () => {
  const { env, temp } = queue();
  const inner = `${HEAVY} sh -c 'stty -echo </dev/tty && echo TERMINAL-OK'`;
  const pty =
    process.platform === 'darwin'
      ? ['-q', '/dev/null', 'sh', '-c', inner]
      : ['-qec', inner, '/dev/null'];
  const result = spawnSync('script', pty, {
    env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 20_000,
  });
  assert.match(result.stdout, /^TERMINAL-OK/m);
  assert.equal(result.status, 0);
  assert.deepEqual(roots(temp), []);
});

test('the floor is 30 GB by default', () => {
  const { env } = queue();
  delete env['KBC_HEAVY_MIN_FREE_GB'];
  const result = run({ ...env, PATH: `${fakeDf(10)}:${env.PATH}` }, 'true');
  assert.equal(result.status, 75);
  assert.match(result.stderr, /10 GB free .* needs 30 GB/);
});
