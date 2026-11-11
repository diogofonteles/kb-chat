import { execFile } from 'node:child_process';
import {
  TRANSCRIBER_SERVICE_LABEL,
  type LocalTranscriberStart,
} from '@kb-chat/contracts';
import type { LocalTranscriberPort } from '../../ports/local-transcriber.js';

/** What one `launchctl` call answered. */
export interface LaunchctlOutcome {
  readonly code: number;
  readonly output: string;
}

/** Runs `launchctl` with these arguments: never a shell, never text from a request. */
export type LaunchctlRunner = (
  args: readonly string[],
) => Promise<LaunchctlOutcome>;

const LAUNCHCTL = '/bin/launchctl';
const TIMEOUT_MS = 10_000;
const OUTPUT_CHARS = 500;

/** A runner of `file` with arguments only (no shell), its output and exit code. */
export const execRunner =
  (file: string): LaunchctlRunner =>
  (args) =>
    new Promise((resolve) => {
      execFile(
        file,
        [...args],
        { timeout: TIMEOUT_MS, shell: false },
        (err, stdout, stderr) => {
          const output = `${stdout}${stderr}`.trim();
          if (err === null) return resolve({ code: 0, output });
          const code = typeof err.code === 'number' ? err.code : 1;
          resolve({ code, output: output || err.message });
        },
      );
    });

/** The real `launchctl` (the owner's Mac in development); tests pass a fake. */
export const execLaunchctl: LaunchctlRunner = execRunner(LAUNCHCTL);

/** `launchctl kickstart -k gui/<uid>/<label>`: starts it, or restarts it when running. */
export const kickstartArgs = (uid: number): readonly string[] => [
  'kickstart',
  '-k',
  `gui/${uid}/${TRANSCRIBER_SERVICE_LABEL}`,
];

/** `launchctl kickstart gui/<uid>/<label>`: starts it only when it does not run. */
export const wakeArgs = (uid: number): readonly string[] => [
  'kickstart',
  `gui/${uid}/${TRANSCRIBER_SERVICE_LABEL}`,
];

/**
 * "Ligar transcritor" when this API runs on the transcriber's Mac (KBC-114 BR-10): the
 * LaunchAgent the transcriber installed is started by its fixed label, for this user.
 */
export class LaunchctlLocalTranscriber implements LocalTranscriberPort {
  constructor(
    private readonly deps: {
      readonly run: LaunchctlRunner;
      readonly uid: number;
    },
  ) {}

  start(): Promise<LocalTranscriberStart> {
    return this.kickstart(kickstartArgs(this.deps.uid));
  }

  wake(): Promise<LocalTranscriberStart> {
    return this.kickstart(wakeArgs(this.deps.uid));
  }

  private async kickstart(
    args: readonly string[],
  ): Promise<LocalTranscriberStart> {
    const done = await this.deps.run(args);
    if (done.code === 0) return { ok: true, detail: 'transcriber started' };
    return {
      ok: false,
      detail: (done.output || `launchctl exited ${done.code}`).slice(
        -OUTPUT_CHARS,
      ),
    };
  }
}
