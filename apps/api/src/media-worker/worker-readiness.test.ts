import { chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ffmpegBins } from '../../test/media-tools.js';
import { assertWorkerReady } from './worker-readiness.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'kbchat-worker-ready-'));
});
afterEach(() => {
  chmodSync(dir, 0o700);
  rmSync(dir, { recursive: true, force: true });
});

describe('assertWorkerReady (fail fast, ADR 0022 §6)', () => {
  it('passes with ffmpeg, ffprobe and a writable folder', async () => {
    await expect(
      assertWorkerReady({ bins: ffmpegBins(), mediaDir: dir }),
    ).resolves.toBeUndefined();
  });

  it('refuses to start without ffmpeg or ffprobe, naming which', async () => {
    const bins = ffmpegBins();
    await expect(
      assertWorkerReady({
        bins: { ...bins, ffmpeg: '/nonexistent/ffmpeg' },
        mediaDir: dir,
      }),
    ).rejects.toThrow('ffmpeg (/nonexistent/ffmpeg) does not run');
    await expect(
      assertWorkerReady({
        bins: { ...bins, ffprobe: '/bin/false' },
        mediaDir: dir,
      }),
    ).rejects.toThrow('ffprobe (/bin/false) does not run');
  });

  it('refuses to start when the media folder cannot be written', async () => {
    chmodSync(dir, 0o500);
    await expect(
      assertWorkerReady({ bins: ffmpegBins(), mediaDir: dir }),
    ).rejects.toThrow(`${dir} is not writable`);
  });
});
