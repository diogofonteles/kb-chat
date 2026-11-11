import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ffmpegBins, makeTone } from '../../test/media-tools.js';
import { chunkArgs, readFlacChunk } from './flac-chunk.js';

const bins = ffmpegBins();
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'kbchat-chunk-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('chunkArgs (KBC-037)', () => {
  it('reads one stretch as 16 kHz mono FLAC on stdout, never to a file', () => {
    const args = chunkArgs({
      source: '/m/a.flac',
      startMs: 1_500,
      endMs: 29_500,
    });
    expect(args.join(' ')).toBe(
      '-hide_banner -nostdin -ss 1.500 -to 29.500 -i /m/a.flac -map 0:a:0 -ac 1 -ar 16000 -c:a flac -f flac -',
    );
  });
});

describe('readFlacChunk (KBC-037)', { timeout: 30_000 }, () => {
  it('reads a stretch of real audio as FLAC bytes', async () => {
    const source = join(dir, 'tone.mp3');
    makeTone(bins, source, 2);
    const flac = await readFlacChunk({
      bins,
      source,
      startMs: 0,
      endMs: 1_000,
    });
    expect(flac.subarray(0, 4).toString()).toBe('fLaC');
  });

  it('says why when ffmpeg fails, or when it is stopped', async () => {
    const failing = join(dir, 'ffmpeg-fails');
    writeFileSync(failing, '#!/bin/sh\necho "no such file" >&2\nexit 1\n');
    chmodSync(failing, 0o755);
    const span = { source: join(dir, 'x.flac'), startMs: 0, endMs: 1_000 };
    await expect(
      readFlacChunk({ bins: { ...bins, ffmpeg: failing }, ...span }),
    ).rejects.toThrow('ffmpeg exited with 1: no such file');
    const stop = new AbortController();
    stop.abort();
    await expect(
      readFlacChunk({ bins, ...span, signal: stop.signal }),
    ).rejects.toThrow('aborted');
  });
});
