import { describe, expect, it } from 'vitest';
import {
  LaunchctlLocalTranscriber,
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
      ['kickstart', '-k', 'gui/501/com.nova-alexandria.transcriber'],
    ]);
    expect(kickstartArgs(0)).toHaveLength(3);
  });

  it('says what launchctl answered when the service is not installed', async () => {
    const launchctl = fake(
      113,
      'Could not find service "com.nova-alexandria.transcriber" in domain for user gui: 501',
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
