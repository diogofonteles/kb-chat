import { chmod, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  LaunchctlLocalTranscriber,
  execRunner,
  kickstartArgs,
  type LaunchctlRunner,
} from './launchctl-local-transcriber.js';

const fake = (code: number, output = '') => {
  const calls: (readonly string[])[] = [];
  const run: LaunchctlRunner = (args) => {
    calls.push(args);
    return Promise.resolve({ code, output });
  };
  return { calls, run };
};

describe('LaunchctlLocalTranscriber (KBC-114 BR-10)', () => {
  it('kickstarts the fixed label in the user domain, with arguments only', async () => {
    const launchctl = fake(0);
    const local = new LaunchctlLocalTranscriber({
      run: launchctl.run,
      uid: 501,
    });
    expect(await local.start()).toEqual({
      ok: true,
      detail: 'transcriber started',
    });
    expect(launchctl.calls).toEqual([
      ['kickstart', '-k', 'gui/501/br.com.nova-alexandria.transcriber'],
    ]);
    expect(kickstartArgs(0)).toHaveLength(3);
  });

  it('wakes it without -k, so a job in hand is never killed (KBC-114 AC-15)', async () => {
    const launchctl = fake(0);
    const local = new LaunchctlLocalTranscriber({
      run: launchctl.run,
      uid: 501,
    });
    expect((await local.wake()).ok).toBe(true);
    expect(launchctl.calls).toEqual([
      ['kickstart', 'gui/501/br.com.nova-alexandria.transcriber'],
    ]);
  });

  it('says what launchctl answered when the service is not installed', async () => {
    const launchctl = fake(
      113,
      'Could not find service "br.com.nova-alexandria.transcriber" in domain for user gui: 501',
    );
    const local = new LaunchctlLocalTranscriber({
      run: launchctl.run,
      uid: 501,
    });
    const started = await local.start();
    expect(started.ok).toBe(false);
    expect(started.detail).toMatch(/Could not find service/);
  });

  it('names the exit code when launchctl says nothing', async () => {
    const local = new LaunchctlLocalTranscriber({ run: fake(5).run, uid: 501 });
    expect((await local.start()).detail).toBe('launchctl exited 5');
  });
});

describe('execRunner (no shell, a script standing in for launchctl)', () => {
  async function script(body: string): Promise<string> {
    const file = join(await mkdtemp(join(tmpdir(), 'launchctl-')), 'fake');
    await writeFile(file, `#!/bin/sh\n${body}\n`);
    await chmod(file, 0o755);
    return file;
  }

  it('passes the arguments as they are and reads the output', async () => {
    const run = execRunner(await script('echo "args: $*"'));
    expect(await run(['kickstart', '-k', 'gui/501/x; rm -rf /'])).toEqual({
      code: 0,
      output: 'args: kickstart -k gui/501/x; rm -rf /',
    });
  });

  it('gives the exit code and the error output', async () => {
    const run = execRunner(await script('echo "not found" >&2; exit 113'));
    expect(await run([])).toEqual({ code: 113, output: 'not found' });
  });

  it('says why when the program is missing', async () => {
    const run = execRunner(join(tmpdir(), 'no-such-launchctl'));
    const done = await run([]);
    expect(done.code).toBe(1);
    expect(done.output).toMatch(/ENOENT/);
  });
});
