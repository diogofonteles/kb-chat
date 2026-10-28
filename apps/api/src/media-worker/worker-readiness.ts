import { access, constants } from 'node:fs/promises';
import type { FfmpegBins } from './ffmpeg.js';
import { runProcess } from './process-runner.js';

/**
 * Fail fast (ADR 0022 §6): before taking any job, ffmpeg and ffprobe must run and the
 * media folder must be writable; otherwise every job would fail four times in a row.
 */
export async function assertWorkerReady(input: {
  readonly bins: FfmpegBins;
  readonly mediaDir: string;
}): Promise<void> {
  for (const [name, bin] of Object.entries(input.bins)) {
    const result = await runProcess(bin, ['-version'], { timeoutMs: 10_000 });
    if (result.code !== 0)
      throw new Error(
        `The media worker cannot start: ${name} (${bin}) does not run`,
      );
  }
  await access(input.mediaDir, constants.W_OK).catch(() => {
    throw new Error(
      `The media worker cannot start: ${input.mediaDir} is not writable`,
    );
  });
}
