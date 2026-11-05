import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

const HELPER = new URL('../test-temp.mjs', import.meta.url).href;

const made = [];
after(() => made.forEach((dir) => rmSync(dir, { recursive: true })));

/** A base of its own, with the variables of the calling run cleared. */
function setup() {
  const base = mkdtempSync(join(tmpdir(), 'kbc-test-temp-'));
  made.push(base);
  const env = { ...process.env, KBC_HEAVY_TEMP: base };
  delete env['CI'];
  delete env['KBC_TEST_TEMP'];
  return { base, env };
}

const script = (body) =>
  `import { privateTemp } from ${JSON.stringify(HELPER)}; privateTemp(); ${body}`;

const run = (env, body) =>
  spawnSync(process.execPath, ['--input-type=module', '-e', script(body)], {
    env,
    encoding: 'utf8',
  });

const WHERE =
  "import('node:os').then(({ tmpdir }) => console.log(tmpdir(), process.env.KBC_TEST_TEMP, process.env.MAC_CHROMIUM_TMPDIR));";

test('gives the process and its children a root, removed on exit', () => {
  const { base, env } = setup();
  const result = run(env, WHERE);
  assert.equal(result.status, 0);
  const [temp, marker, chrome] = result.stdout.trim().split(' ');
  assert.ok(temp.startsWith(`${base}/`));
  assert.equal(marker, temp);
  assert.equal(chrome, temp);
  assert.deepEqual(readdirSync(base), []);
});

test('a run that fails removes it too', () => {
  const { base, env } = setup();
  assert.equal(run(env, 'process.exit(3);').status, 3);
  assert.deepEqual(readdirSync(base), []);
});

test('SIGTERM and SIGHUP remove it and end the process', async () => {
  for (const [signal, code] of [
    ['SIGTERM', 143],
    ['SIGHUP', 129],
  ]) {
    const { base, env } = setup();
    const child = spawn(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        script("console.log('up'); setInterval(() => {}, 1000);"),
      ],
      { env, stdio: ['ignore', 'pipe', 'inherit'] },
    );
    await new Promise((resolve) => child.stdout.once('data', resolve));
    assert.equal(readdirSync(base).length, 1);
    child.kill(signal);
    const exit = await new Promise((resolve) => child.on('close', resolve));
    assert.equal(exit, code);
    assert.deepEqual(readdirSync(base), []);
  }
});

test('the root is named after its owner, for the sweep of tools/heavy.sh', () => {
  const { env } = setup();
  const result = run(
    env,
    'console.log(`${process.pid} ${process.env.TMPDIR}`);',
  );
  const [pid, temp] = result.stdout.trim().split(' ');
  assert.match(temp, new RegExp(`/${pid}\\.[^/]+$`));
  assert.equal(existsSync(temp), false);
});

test('a run that has a root keeps it, and so does CI', () => {
  for (const inside of [{ KBC_TEST_TEMP: '/given' }, { CI: 'true' }]) {
    const { base, env } = setup();
    const result = run(
      { ...env, ...inside, TMPDIR: '/given' },
      'console.log(process.env.TMPDIR);',
    );
    assert.equal(result.stdout, '/given\n');
    assert.deepEqual(readdirSync(base), []);
  }
});
