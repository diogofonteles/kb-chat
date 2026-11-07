/**
 * The production sync scripts (KBC-100 FR-4, FR-5, BR-7), run against temporary folders with
 * fake docker, flock, ssh, rsync and sqlite3: nothing reaches a VM, nothing stops an API.
 */
import { spawn } from 'node:child_process';
import {
  chmod,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SCRIPTS = fileURLToPath(
  new URL('../../../deploy/scripts', import.meta.url),
);
const SQLITE_HEADER = 'SQLite format 3\u0000 fake index';

interface Run {
  readonly code: number;
  readonly output: string;
}

/** Runs a script; `whileRunning` sees it from outside (the API answering the trigger). */
function run(
  command: string,
  options: {
    args?: readonly string[];
    env: Record<string, string>;
    whileRunning?: () => Promise<void>;
  },
): Promise<Run> {
  return new Promise((resolve, reject) => {
    const child = spawn('bash', [command, ...(options.args ?? [])], {
      env: { ...process.env, ...options.env },
    });
    let output = '';
    child.stdout.on('data', (chunk: Buffer) => (output += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (output += chunk.toString()));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code: code ?? -1, output }));
    void options.whileRunning?.();
  });
}

async function fakeBin(dir: string, name: string, body: string) {
  const file = join(dir, name);
  await writeFile(file, `#!/usr/bin/env bash\n${body}\n`);
  await chmod(file, 0o755);
}

/** A VM's /srv/kb-chat: deploy scripts, a running release, an index sent by the Mac. */
async function aVm(options: { previous: 'file' | 'link' | 'none' }) {
  const root = await mkdtemp(join(tmpdir(), 'kbchat-vm-'));
  const bin = join(root, 'bin');
  const log = join(root, 'calls.log');
  await mkdir(bin);
  await mkdir(join(root, 'deploy', 'scripts'), { recursive: true });
  await cp(
    join(SCRIPTS, 'install-index.sh'),
    join(root, 'deploy', 'scripts', 'install-index.sh'),
  );
  await fakeBin(
    join(root, 'deploy', 'scripts'),
    'smoke.sh',
    `echo smoke >>"${log}"; exit "\${FAKE_SMOKE_EXIT:-0}"`,
  );
  await writeFile(join(root, 'deploy', 'release.env'), 'KB_CHAT_TAG=x\n');
  await fakeBin(bin, 'docker', `echo "docker $*" >>"${log}"`);
  await fakeBin(
    bin,
    'flock',
    `echo "flock $*" >>"${log}"; [ -z "\${FAKE_LOCK_HELD:-}" ]`,
  );
  const incoming = join(root, 'qmd', 'incoming');
  const cache = join(root, 'qmd', 'cache');
  await mkdir(incoming, { recursive: true });
  await mkdir(cache, { recursive: true });
  await writeFile(join(incoming, 'index.sqlite'), `${SQLITE_HEADER} new`);
  await writeFile(
    join(incoming, 'index.yml'),
    'collections:\n  hermetismo:\n    path: /vault/hermetismo\n',
  );
  if (options.previous === 'file')
    await writeFile(join(cache, 'index.sqlite'), `${SQLITE_HEADER} old`);
  if (options.previous === 'link') {
    await writeFile(join(cache, 'index-1.sqlite'), `${SQLITE_HEADER} old`);
    await writeFile(join(cache, 'index-0.sqlite'), `${SQLITE_HEADER} older`);
    await symlink('index-1.sqlite', join(cache, 'index.sqlite'));
  }
  const env = {
    KB_CHAT_ROOT: root,
    PATH: `${bin}:${process.env['PATH'] ?? ''}`,
    KB_CHAT_RELOAD_WAIT_S: '3',
  };
  return { root, cache, log, env };
}

/** The API's side of the swap: reads the trigger, answers with the ack. */
const answerTrigger = (cache: string) => async () => {
  const trigger = join(cache, 'reload-index');
  for (let tries = 0; tries < 100; tries += 1) {
    const asked = await readFile(trigger, 'utf8').catch(() => null);
    if (asked) {
      await writeFile(`${trigger}.ack`, asked);
      return;
    }
    await new Promise((done) => setTimeout(done, 30));
  }
};

const calls = (log: string) => readFile(log, 'utf8').catch(() => '');

describe('install-index.sh --hot (KBC-100 FR-5, AC-13)', () => {
  it('swaps the index by one rename and asks the API to reload, never stopping it', async () => {
    const vm = await aVm({ previous: 'file' });
    const done = await run(join(vm.root, 'deploy/scripts/install-index.sh'), {
      args: ['--hot'],
      env: vm.env,
      whileRunning: answerTrigger(vm.cache),
    });

    expect(done.code, done.output).toBe(0);
    expect(await calls(vm.log)).not.toContain('docker');
    expect(await calls(vm.log)).toContain('flock -w 300 9');
    expect(await calls(vm.log)).toContain('smoke');
    const target = await readlink(join(vm.cache, 'index.sqlite'));
    expect(target).toMatch(/^index-\d{14}\.sqlite$/);
    expect(await readFile(join(vm.cache, target), 'utf8')).toContain('new');
    expect(
      (await readFile(join(vm.cache, 'reload-index'), 'utf8')).trim(),
    ).toBe(target);
    // The old file, still open by the running qmd, keeps a name for a way back.
    const kept = (await readdir(vm.cache)).filter((one) =>
      one.startsWith('index-before-'),
    );
    expect(kept).toHaveLength(1);
  });

  it('keeps the previous index and prunes the older ones', async () => {
    const vm = await aVm({ previous: 'link' });
    const done = await run(join(vm.root, 'deploy/scripts/install-index.sh'), {
      args: ['--hot'],
      env: vm.env,
      whileRunning: answerTrigger(vm.cache),
    });
    expect(done.code, done.output).toBe(0);
    const files = await readdir(vm.cache);
    expect(files).toContain('index-1.sqlite');
    expect(files).not.toContain('index-0.sqlite');
  });

  it("without the API's answer it goes back to the previous index and fails", async () => {
    const vm = await aVm({ previous: 'link' });
    const done = await run(join(vm.root, 'deploy/scripts/install-index.sh'), {
      args: ['--hot'],
      env: { ...vm.env, KB_CHAT_RELOAD_WAIT_S: '1' },
    });
    expect(done.code).not.toBe(0);
    expect(done.output).toContain('going back to the previous index');
    expect(await readlink(join(vm.cache, 'index.sqlite'))).toBe(
      'index-1.sqlite',
    );
    expect(
      (await readFile(join(vm.cache, 'reload-index'), 'utf8')).trim(),
    ).toBe('index-1.sqlite');
    expect(await calls(vm.log)).not.toContain('docker');
  });

  it('AC-14: while a deploy holds the lock nothing is swapped', async () => {
    const vm = await aVm({ previous: 'link' });
    const done = await run(join(vm.root, 'deploy/scripts/install-index.sh'), {
      args: ['--hot'],
      env: { ...vm.env, FAKE_LOCK_HELD: '1' },
    });
    expect(done.code).not.toBe(0);
    expect(done.output).toContain('another deploy holds');
    expect(await readlink(join(vm.cache, 'index.sqlite'))).toBe(
      'index-1.sqlite',
    );
    expect(
      (await lstat(join(vm.root, 'qmd/incoming/index.sqlite'))).isFile(),
    ).toBe(true);
  });

  it('before the first deploy it only puts the files in place', async () => {
    const vm = await aVm({ previous: 'none' });
    await rm(join(vm.root, 'deploy', 'release.env'));
    const done = await run(join(vm.root, 'deploy/scripts/install-index.sh'), {
      args: ['--hot'],
      env: vm.env,
    });
    expect(done.code, done.output).toBe(0);
    expect(done.output).toContain('the first deploy will start the API');
  });
});

/** The owner's Mac: a vault, its QMD index and config, and fake ssh, rsync and sqlite3. */
async function aMac() {
  const home = await mkdtemp(join(tmpdir(), 'kbchat-mac-'));
  const bin = join(home, 'bin');
  const log = join(home, 'calls.log');
  const vault = join(home, 'vault');
  await mkdir(bin);
  await mkdir(join(vault, 'hermetismo'), { recursive: true });
  await writeFile(join(vault, 'kb.toml'), '');
  await writeFile(join(vault, 'hermetismo', 'topic.yaml'), 'title: H\n');
  await mkdir(join(home, '.cache', 'qmd'), { recursive: true });
  await writeFile(join(home, '.cache', 'qmd', 'index.sqlite'), SQLITE_HEADER);
  await mkdir(join(home, '.config', 'qmd'), { recursive: true });
  await writeFile(
    join(home, '.config', 'qmd', 'index.yml'),
    `collections:\n  hermetismo:\n    path: ${vault}/hermetismo\n`,
  );
  await fakeBin(bin, 'ssh', `echo "ssh $*" >>"${log}"`);
  await fakeBin(
    bin,
    'rsync',
    `printf 'rsync' >>"${log}"; printf ' [%s]' "$@" >>"${log}"; echo >>"${log}"`,
  );
  await fakeBin(
    bin,
    'sqlite3',
    `echo "sqlite3 $*" >>"${log}"; touch "$(echo "$2" | sed "s/.backup '\\(.*\\)'/\\1/")"`,
  );
  const env = {
    HOME: home,
    XDG_CONFIG_HOME: join(home, '.config'),
    KB_VAULT: vault,
    PATH: `${bin}:${process.env['PATH'] ?? ''}`,
  };
  return { home, log, env };
}

describe('sync-vault.sh (KBC-100 FR-4, BR-7)', () => {
  it('AC-14: the VM side of every vault and index transfer waits for the deploy lock', async () => {
    const mac = await aMac();
    const done = await run(join(SCRIPTS, 'sync-vault.sh'), {
      args: ['--host', 'ubuntu@vm', '--hot'],
      env: mac.env,
    });
    expect(done.code, done.output).toBe(0);
    const rsyncs = (await calls(mac.log))
      .split('\n')
      .filter((line) => line.startsWith('rsync'));
    expect(rsyncs).toHaveLength(3);
    for (const line of rsyncs)
      expect(line).toContain(
        '[--rsync-path=flock -w 600 /srv/kb-chat/deploy/.lock rsync]',
      );
  });

  it('--hot asks the VM for the hot swap; without it the old restart stays', async () => {
    const hot = await aMac();
    await run(join(SCRIPTS, 'sync-vault.sh'), {
      args: ['--host', 'ubuntu@vm', '--hot'],
      env: hot.env,
    });
    expect(await calls(hot.log)).toContain(
      'ssh ubuntu@vm sudo /srv/kb-chat/deploy/scripts/install-index.sh --hot',
    );
    const plain = await aMac();
    await run(join(SCRIPTS, 'sync-vault.sh'), {
      args: ['--host', 'ubuntu@vm'],
      env: plain.env,
    });
    const ssh = (await calls(plain.log))
      .split('\n')
      .find((line) => line.startsWith('ssh'));
    expect(ssh).toBe(
      'ssh ubuntu@vm sudo /srv/kb-chat/deploy/scripts/install-index.sh',
    );
  });
});
