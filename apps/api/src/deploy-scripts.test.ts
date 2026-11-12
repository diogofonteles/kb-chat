/**
 * The production sync scripts (KBC-100 FR-4, FR-5, BR-7), run against temporary folders with
 * fake docker, flock, ssh, rsync and sqlite3: nothing reaches a VM, nothing stops an API.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
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
import { describe, expect, it, vi } from 'vitest';

// Each test runs the real bash scripts, a few dozen forks each (cp, mv, grep, the fakes): under
// a second alone, several on a busy machine.
vi.setConfig({ testTimeout: 15_000 });

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
    whileRunning?: (child: ChildProcess) => Promise<void>;
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
    void options.whileRunning?.(child);
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
    // The answer ends the wait at once, so a long budget costs nothing and a busy machine never
    // runs out of it; the tests without an answer set their own. Polled often: a poll of a
    // second made every swap wait one.
    KB_CHAT_RELOAD_WAIT_S: '30',
    KB_CHAT_RELOAD_POLL_S: '0.05',
  };
  return { root, cache, log, env };
}

/** The API's side of the swap: reads the trigger, answers with the ack, while the script runs. */
const answerTrigger = (cache: string) => async (child: ChildProcess) => {
  const trigger = join(cache, 'reload-index');
  while (child.exitCode === null && child.signalCode === null) {
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

  it('review 4: a link left by an interrupted run does not stop the next swap', async () => {
    const vm = await aVm({ previous: 'link' });
    await symlink('index-0.sqlite', join(vm.cache, '.index.sqlite.next'));
    const done = await run(join(vm.root, 'deploy/scripts/install-index.sh'), {
      args: ['--hot'],
      env: vm.env,
      whileRunning: answerTrigger(vm.cache),
    });

    expect(done.code, done.output).toBe(0);
    const target = await readlink(join(vm.cache, 'index.sqlite'));
    expect(target).toMatch(/^index-\d{14}\.sqlite$/);
    expect(await readFile(join(vm.cache, target), 'utf8')).toContain('new');
    expect((await readdir(vm.cache)).includes('.index.sqlite.next')).toBe(
      false,
    );
  });

  it('review 4: a swap that fails half way puts the config and the index back together', async () => {
    const vm = await aVm({ previous: 'link' });
    const config = join(vm.root, 'qmd', 'config');
    await mkdir(config, { recursive: true });
    await writeFile(join(config, 'index.yml'), 'collections: {} # old\n');
    // Something the swap cannot replace: the rename onto index.sqlite fails.
    await mkdir(join(vm.cache, '.index.sqlite.next', 'stuck'), {
      recursive: true,
    });
    const done = await run(join(vm.root, 'deploy/scripts/install-index.sh'), {
      args: ['--hot'],
      env: vm.env,
    });

    expect(done.code).not.toBe(0);
    expect(done.output).toContain('putting the previous index and config back');
    expect(await readlink(join(vm.cache, 'index.sqlite'))).toBe(
      'index-1.sqlite',
    );
    expect(await readFile(join(config, 'index.yml'), 'utf8')).toBe(
      'collections: {} # old\n',
    );
    // Nothing was asked of the API.
    expect(
      await readFile(join(vm.cache, 'reload-index'), 'utf8').catch(() => null),
    ).toBeNull();
  });

  it('review 3: cut short while waiting for the API, it asks the API again for the previous index', async () => {
    const vm = await aVm({ previous: 'link' });
    const trigger = join(vm.cache, 'reload-index');
    const done = await run(join(vm.root, 'deploy/scripts/install-index.sh'), {
      args: ['--hot'],
      env: { ...vm.env, KB_CHAT_RELOAD_WAIT_S: '30' },
      // The SSH session drops once the API was asked for the new index.
      whileRunning: async (child) => {
        for (let tries = 0; tries < 200; tries += 1) {
          if (await readFile(trigger, 'utf8').catch(() => null)) break;
          await new Promise((wait) => setTimeout(wait, 25));
        }
        child.kill('SIGHUP');
      },
    });

    expect(done.code).not.toBe(0);
    expect(done.output).toContain('putting the previous index and config back');
    expect(await readlink(join(vm.cache, 'index.sqlite'))).toBe(
      'index-1.sqlite',
    );
    expect((await readFile(trigger, 'utf8')).trim()).toBe('index-1.sqlite');
    expect((await readdir(vm.cache)).includes('.index.sqlite.next')).toBe(
      false,
    );
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
  // A read of the VM's install-index.sh (the hot swap probe) reads FAKE_VM_INSTALL_INDEX.
  await fakeBin(
    bin,
    'ssh',
    [
      `echo "ssh $*" >>"${log}"`,
      'if [ "$2" = grep ]; then',
      '  [ -n "${FAKE_SSH_DOWN:-}" ] && exit 255',
      '  shift 2',
      '  exec grep "${@:1:$#-1}" "$FAKE_VM_INSTALL_INDEX"',
      'fi',
    ].join('\n'),
  );
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
    // The VM runs this checkout's install-index.sh unless a test says otherwise.
    FAKE_VM_INSTALL_INDEX: join(SCRIPTS, 'install-index.sh'),
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

  it('review 3: a VM whose install-index.sh has no hot swap gets nothing, and its API is never restarted', async () => {
    const mac = await aMac();
    // The install-index.sh of a release before KBC-100: it ignores --hot and restarts the API.
    const old = join(mac.home, 'old-install-index.sh');
    await writeFile(
      old,
      '#!/usr/bin/env bash\nset -euo pipefail\ncompose stop api\n',
    );
    const done = await run(join(SCRIPTS, 'sync-vault.sh'), {
      args: ['--host', 'ubuntu@vm', '--hot'],
      env: { ...mac.env, FAKE_VM_INSTALL_INDEX: old },
    });

    expect(done.code).not.toBe(0);
    expect(done.output).toContain('has no hot swap');
    expect(done.output).toContain('nothing was sent');
    const log = await calls(mac.log);
    expect(log).not.toContain('rsync');
    expect(log).not.toContain('install-index.sh --hot');
    expect(log.trim().split('\n')).toEqual([
      'ssh ubuntu@vm grep -qx KB_CHAT_INSTALL_INDEX_HOT=1 /srv/kb-chat/deploy/scripts/install-index.sh',
    ]);
  });

  it('review 3: a VM that cannot be asked gets nothing either', async () => {
    const mac = await aMac();
    const done = await run(join(SCRIPTS, 'sync-vault.sh'), {
      args: ['--host', 'ubuntu@vm', '--hot'],
      env: { ...mac.env, FAKE_SSH_DOWN: '1' },
    });

    expect(done.code).not.toBe(0);
    expect(done.output).toContain('could not ask the VM');
    expect(await calls(mac.log)).not.toContain('rsync');
  });

  it("review 3: this release's install-index.sh says it swaps hot", async () => {
    const script = await readFile(join(SCRIPTS, 'install-index.sh'), 'utf8');
    expect(script.split('\n')).toContain('KB_CHAT_INSTALL_INDEX_HOT=1');
  });
});

/** A VM for the media scripts (KBC-116): the deploy folder, fake docker, flock, id and chown. */
async function aMediaVm(options: {
  media: 'on' | 'off';
  root?: boolean;
  env?: string;
}) {
  const root = await mkdtemp(join(tmpdir(), 'kbchat-media-'));
  const bin = join(root, 'bin');
  const log = join(root, 'calls.log');
  await mkdir(bin);
  await mkdir(join(root, 'deploy', 'scripts'), { recursive: true });
  await mkdir(join(root, 'media'), { mode: 0o700 });
  await chmod(join(root, 'media'), 0o700);
  for (const script of ['import-media.sh', 'deploy.sh'])
    await cp(join(SCRIPTS, script), join(root, 'deploy', 'scripts', script));
  await fakeBin(
    join(root, 'deploy', 'scripts'),
    'smoke.sh',
    `echo smoke >>"${log}"`,
  );
  await writeFile(
    join(root, 'deploy', '.env'),
    `KB_CHAT_MEDIA=${options.media}\nKB_CHAT_OWNER_EMAIL="owner@example.com"\n${options.env ?? ''}`,
  );
  await writeFile(join(root, 'deploy', 'release.env'), 'KB_CHAT_TAG=abc\n');
  await fakeBin(
    bin,
    'docker',
    [
      `echo "docker $*" >>"${log}"`,
      'case "$*" in',
      '  *"config --images"*) echo ghcr.io/x/kb-chat-web:abc; echo ghcr.io/x/kb-chat-api:abc ;;',
      '  *"import --package"*) echo "inserted 1"; exit "${FAKE_IMPORT_EXIT:-0}" ;;',
      'esac',
    ].join('\n'),
  );
  await fakeBin(bin, 'flock', `echo "flock $*" >>"${log}"`);
  await fakeBin(bin, 'chown', `echo "chown $*" >>"${log}"`);
  await fakeBin(bin, 'chgrp', `echo "chgrp $*" >>"${log}"`);
  await fakeBin(
    bin,
    'install',
    `echo "install $*" >>"${log}"; [ -z "\${FAKE_INSTALL_FAILS:-}" ]`,
  );
  if (options.root !== false)
    await fakeBin(bin, 'id', `[ "$1" = -u ] && echo 0 || /usr/bin/id "$@"`);
  const uid = String(process.getuid?.() ?? 0);
  const env = {
    KB_CHAT_ROOT: root,
    KB_CHAT_DEPLOY_DIR: join(root, 'deploy'),
    KB_CHAT_APP_UID: uid,
    PATH: `${bin}:${process.env['PATH'] ?? ''}`,
  };
  return { root, log, env };
}

/** A package as push-media.sh leaves it: files and their SHA256SUMS. */
async function aPackage(root: string): Promise<string> {
  const dir = join(root, 'inbox', 'package');
  await mkdir(join(dir, 'files', 'audio'), { recursive: true });
  await writeFile(join(dir, 'media.db'), 'db');
  await writeFile(join(dir, 'files', 'audio', 'a.m4a'), 'audio');
  const sum = (text: string) => createHash('sha256').update(text).digest('hex');
  await writeFile(
    join(dir, 'SHA256SUMS'),
    `${sum('db')}  media.db\n${sum('audio')}  files/audio/a.m4a\n`,
  );
  return dir;
}

describe('deploy.sh ensure_media_dir (KBC-116 FR-11, AC-16)', () => {
  const ensure = (root: string, env: Record<string, string>) =>
    run('-c', {
      args: [
        `source "${join(root, 'deploy', 'scripts', 'deploy.sh')}" && ensure_media_dir`,
      ],
      env,
    });

  it('as root, gives a media folder Docker made as root back to the app (10001, 0700)', async () => {
    const vm = await aMediaVm({ media: 'off' });
    await chmod(join(vm.root, 'media'), 0o755);

    const done = await ensure(vm.root, vm.env);

    expect(done.code).toBe(0);
    expect(done.output).toContain(`gave the app ${join(vm.root, 'media')}`);
    expect(await calls(vm.log)).toContain(
      `chown 10001:10001 ${join(vm.root, 'media')}`,
    );
    expect((await lstat(join(vm.root, 'media'))).mode & 0o777).toBe(0o700);
  });

  it('without root it only warns about a wrong owner and lets the deploy go on', async () => {
    const vm = await aMediaVm({ media: 'off', root: false });

    const done = await ensure(vm.root, vm.env);

    expect(done.code).toBe(0);
    expect(done.output).toContain("is not the app's (uid 10001, 0700)");
    expect(await calls(vm.log)).not.toContain('chown');
  });
});

describe('import-media.sh (KBC-116, ADR 0038)', () => {
  const importMedia = (
    vm: { root: string; env: Record<string, string> },
    args: string[],
  ) =>
    run(join(vm.root, 'deploy', 'scripts', 'import-media.sh'), {
      args,
      env: vm.env,
    });

  it('refuses while the media library is off, touching nothing', async () => {
    const vm = await aMediaVm({ media: 'off' });
    const pkg = await aPackage(vm.root);

    const done = await importMedia(vm, [pkg]);

    expect(done.code).toBe(1);
    expect(done.output).toContain('the media library is off');
    expect(await calls(vm.log)).toBe('');
  });

  it('AC-10: refuses a package that does not match its checksums before any docker call', async () => {
    const vm = await aMediaVm({ media: 'on' });
    const pkg = await aPackage(vm.root);
    await writeFile(join(pkg, 'files', 'audio', 'a.m4a'), 'tampered');

    const done = await importMedia(vm, [pkg]);

    expect(done.code).toBe(1);
    expect(done.output).toContain(
      'does not match its checksums: nothing changed',
    );
    expect(await calls(vm.log)).toBe('');
  });

  it('AC-11: a dry run imports into a copy in a sealed one-off container, with the API up', async () => {
    const vm = await aMediaVm({ media: 'on' });
    const pkg = await aPackage(vm.root);

    const done = await importMedia(vm, [pkg, '--dry-run']);

    expect(done.code).toBe(0);
    const log = await calls(vm.log);
    expect(log).not.toContain('stop');
    const runLine =
      log.split('\n').find((line) => line.startsWith('docker run')) ?? '';
    expect(runLine).toContain('--network none --read-only');
    expect(runLine).toContain(`-v ${pkg}:/import:ro`);
    expect(runLine).toContain('-e KB_CHAT_OWNER_EMAIL=owner@example.com');
    expect(runLine).toContain(
      'ghcr.io/x/kb-chat-api:abc node dist/media-transfer-main.js import --package /import --dry-run',
    );
  });

  it('the real run stops the API, keeps a rollback point, imports, brings the stack back and smokes', async () => {
    const vm = await aMediaVm({ media: 'on' });
    const pkg = await aPackage(vm.root);
    await writeFile(join(vm.root, 'media', 'media.db'), 'live');
    await mkdir(join(vm.root, 'state'));
    await writeFile(join(vm.root, 'state', 'authors.json'), '{}');

    const done = await importMedia(vm, [pkg]);

    expect(done.code).toBe(0);
    const steps = (await calls(vm.log))
      .split('\n')
      .filter((line) => /compose .*(stop|up)|docker run|smoke/.test(line))
      .map((line) =>
        line.includes('node -e')
          ? 'snapshot'
          : line.includes('import --package')
            ? 'import'
            : line.replace(/^.* (stop|up) .*$/, '$1'),
      );
    expect(steps).toEqual(['stop', 'snapshot', 'import', 'up', 'smoke']);
    const kept = await readdir(join(vm.root, 'state'));
    expect(
      kept.some((name) => name.startsWith('authors.json.before-import-')),
    ).toBe(true);
  });
});

describe('import-media.sh and push-media.sh after review round 1 (KBC-116)', () => {
  const importMedia = (
    vm: { root: string; env: Record<string, string> },
    args: string[],
    env: Record<string, string> = {},
  ) =>
    run(join(vm.root, 'deploy', 'scripts', 'import-media.sh'), {
      args,
      env: { ...vm.env, ...env },
    });

  /** A VM with a live media database and authors, as the real run finds them. */
  async function aLiveMediaVm() {
    const vm = await aMediaVm({ media: 'on' });
    await writeFile(join(vm.root, 'media', 'media.db'), 'live');
    await mkdir(join(vm.root, 'state'));
    await writeFile(join(vm.root, 'state', 'authors.json'), '{}');
    return vm;
  }

  const steps = async (log: string) =>
    (await calls(log))
      .split('\n')
      .filter((line) => /compose .*(stop|up)|docker run|smoke/.test(line))
      .map((line) =>
        line.includes('node -e')
          ? 'snapshot'
          : line.includes('import --package')
            ? 'import'
            : line.replace(/^.* (stop|up) .*$/, '$1'),
      );

  it('both scripts parse (bash -n)', async () => {
    for (const script of ['import-media.sh', 'push-media.sh']) {
      const done = await run('-n', {
        args: [join(SCRIPTS, script)],
        env: {},
      });
      expect([script, done.code, done.output]).toEqual([script, 0, '']);
    }
  });

  it('a real run with something held brings the stack back, smokes and exits 3', async () => {
    const vm = await aLiveMediaVm();
    const pkg = await aPackage(vm.root);

    const done = await importMedia(vm, [pkg], { FAKE_IMPORT_EXIT: '3' });

    expect(done.code).toBe(3);
    expect(await steps(vm.log)).toEqual([
      'stop',
      'snapshot',
      'import',
      'up',
      'smoke',
    ]);
  });

  it('a real run whose import fails still brings the stack back, smokes and exits 1', async () => {
    const vm = await aLiveMediaVm();
    const pkg = await aPackage(vm.root);

    const done = await importMedia(vm, [pkg], { FAKE_IMPORT_EXIT: '1' });

    expect(done.code).toBe(1);
    expect(await steps(vm.log)).toEqual([
      'stop',
      'snapshot',
      'import',
      'up',
      'smoke',
    ]);
  });

  it("--verify runs the check in the running API's container", async () => {
    const vm = await aMediaVm({ media: 'on' });

    const done = await importMedia(vm, ['--verify']);

    expect(done.code).toBe(0);
    expect(await calls(vm.log)).toContain(
      'exec -T api node dist/media-transfer-main.js verify',
    );
  });

  it('a rollback point that cannot be kept stops the run before the import', async () => {
    const vm = await aLiveMediaVm();
    const pkg = await aPackage(vm.root);

    const done = await importMedia(vm, [pkg], { FAKE_INSTALL_FAILS: '1' });

    expect(done.code).toBe(1);
    expect(await steps(vm.log)).toEqual(['stop', 'up']);
  });

  it("F-5: uses the data folder compose mounts (KB_CHAT_DATA), not the deploy's", async () => {
    const vm = await aMediaVm({ media: 'on' });
    const data = join(vm.root, 'data');
    await mkdir(join(data, 'media'), { recursive: true, mode: 0o700 });
    await chmod(join(data, 'media'), 0o700);
    await writeFile(
      join(vm.root, 'deploy', '.env'),
      `KB_CHAT_MEDIA=on\nKB_CHAT_OWNER_EMAIL=owner@example.com\nKB_CHAT_DATA=${data}\n`,
    );
    const pkg = await aPackage(vm.root);

    const done = await importMedia(vm, [pkg, '--dry-run']);

    expect(done.code).toBe(0);
    const runLine =
      (await calls(vm.log))
        .split('\n')
        .find((line) => line.startsWith('docker run')) ?? '';
    expect(runLine).toContain(`-v ${data}/media:/data/media`);
    expect(runLine).toContain(`-v ${data}/state:/data/state`);
    expect(runLine).toContain(`-v ${data}/vault:/vault:ro`);
  });

  it('a dry run mounts the app state read-only', async () => {
    const vm = await aMediaVm({ media: 'on' });
    const pkg = await aPackage(vm.root);

    await importMedia(vm, [pkg, '--dry-run']);

    const runLine =
      (await calls(vm.log))
        .split('\n')
        .find((line) => line.startsWith('docker run')) ?? '';
    expect(runLine).toContain(`-v ${join(vm.root, 'state')}:/data/state:ro`);
  });

  it("F-1: the package on the VM is the app group's only, never world-readable", async () => {
    const vm = await aMediaVm({ media: 'on' });
    const pkg = await aPackage(vm.root);
    await chmod(join(pkg, 'media.db'), 0o644);

    await importMedia(vm, [pkg, '--dry-run']);

    expect((await lstat(join(pkg, 'media.db'))).mode & 0o007).toBe(0);
    expect((await lstat(pkg)).mode & 0o007).toBe(0);
    expect(await calls(vm.log)).toContain(
      `chgrp -R ${vm.env.KB_CHAT_APP_UID} ${pkg}`,
    );
  });

  it('keeps the last five rollback points and prunes older ones', async () => {
    const vm = await aLiveMediaVm();
    const pkg = await aPackage(vm.root);
    await mkdir(join(vm.root, 'media', 'backup'));
    for (let day = 1; day <= 7; day += 1) {
      const stamp = `202601${String(day).padStart(2, '0')}T000000Z`;
      await writeFile(
        join(vm.root, 'media', 'backup', `media.db.before-import-${stamp}`),
        'old',
      );
      await writeFile(
        join(vm.root, 'state', `authors.json.before-import-${stamp}`),
        '{}',
      );
    }

    expect((await importMedia(vm, [pkg])).code).toBe(0);

    const backups = (await readdir(join(vm.root, 'media', 'backup'))).sort();
    expect(backups).toHaveLength(5);
    expect(backups[0]).toBe('media.db.before-import-20260103T000000Z');
    const authors = (await readdir(join(vm.root, 'state'))).filter((name) =>
      name.startsWith('authors.json.before-import-'),
    );
    expect(authors).toHaveLength(5);
  });

  it("push-media.sh sends the package for the app group only, with flags macOS's rsync accepts", async () => {
    const mac = await aMac();
    await fakeBin(
      join(mac.home, 'bin'),
      'pnpm',
      `echo "pnpm $*" >>"${mac.log}"`,
    );

    const done = await run(join(SCRIPTS, 'push-media.sh'), {
      args: ['--host', 'ubuntu@vm', '--dry-run'],
      env: mac.env,
    });

    expect(done.code).toBe(0);
    const log = await calls(mac.log);
    expect(log).toContain('-m 2750');
    expect(log).toContain('[--no-group]');
    // macOS's rsync (openrsync) refuses --chmod: the 2750 inbox keeps others out instead
    expect(log).not.toContain('--chmod');
    expect(log).not.toContain('0644');
  });
});
