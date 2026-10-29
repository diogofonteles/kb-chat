import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ffmpegBins, makeTone } from '../../test/media-tools.js';
import {
  InvalidMediaError,
  probe,
  progressOf,
  transcodeAudio,
} from './ffmpeg.js';
import { runProcess } from './process-runner.js';

describe('progressOf', () => {
  it.each([
    ['out_time_us=5000000', 10_000, 50],
    ['out_time_ms=2500000', 10_000, 25],
    ['out_time_us=0', 10_000, 0],
    ['out_time_us=99999999', 10_000, 99],
  ])('reads %s of %i ms as %i%%', (line, duration, percent) => {
    expect(progressOf(line, duration)).toBe(percent);
  });

  it('ignores other lines and an unknown duration', () => {
    expect(progressOf('progress=continue', 10_000)).toBeNull();
    expect(progressOf('out_time=00:00:05.000000', 10_000)).toBeNull();
    expect(progressOf('out_time_us=5000000', 0)).toBeNull();
  });
});

describe('runProcess', () => {
  it('collects stdout lines and the exit code', async () => {
    const lines: string[] = [];
    const result = await runProcess(
      '/bin/sh',
      ['-c', 'echo one; echo two; exit 3'],
      {
        timeoutMs: 5_000,
        onLine: (line) => lines.push(line),
      },
    );
    expect(result).toMatchObject({ code: 3, timedOut: false, aborted: false });
    expect(lines).toEqual(['one', 'two']);
  });

  it('kills a program that passes its time limit', async () => {
    const result = await runProcess('/bin/sleep', ['5'], { timeoutMs: 100 });
    expect(result.timedOut).toBe(true);
    expect(result.code).toBeNull();
  });

  it('kills a program when asked to stop', async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 50);
    const result = await runProcess('/bin/sleep', ['5'], {
      timeoutMs: 10_000,
      signal: controller.signal,
    });
    expect(result.aborted).toBe(true);
  });

  it('does not start when already stopped', async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await runProcess('/bin/sleep', ['5'], {
      timeoutMs: 10_000,
      signal: controller.signal,
    });
    expect(result.aborted).toBe(true);
  });

  it('answers once, with no code, for a program that does not exist', async () => {
    const result = await runProcess('/nonexistent/ffmpeg', [], {
      timeoutMs: 1_000,
    });
    expect(result.code).toBeNull();
    expect(result.stderrTail).toMatch(/ENOENT/);
  });
});

describe('probe and transcodeAudio (real ffmpeg)', () => {
  const bins = ffmpegBins();
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'kbchat-ffmpeg-'));
    makeTone(bins, join(dir, 'tone.mp3'), 3);
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('reads the duration and the audio stream', async () => {
    const found = await probe(bins, join(dir, 'tone.mp3'));
    expect(found.hasAudio).toBe(true);
    expect(found.durationMs).toBeGreaterThan(2_900);
    expect(found.durationMs).toBeLessThan(3_200);
  });

  it('calls a file that is not media invalid', async () => {
    const fake = join(dir, 'corrupt.mp3');
    writeFileSync(fake, 'this is not an mp3 at all, just text');
    await expect(probe(bins, fake)).rejects.toBeInstanceOf(InvalidMediaError);
  });

  it('never blames the file when ffprobe itself is missing', async () => {
    const missing = { ...bins, ffprobe: '/nonexistent/ffprobe' };
    const failure = probe(missing, join(dir, 'tone.mp3'));
    await expect(failure).rejects.toThrow(/did not finish/);
    await expect(failure).rejects.not.toBeInstanceOf(InvalidMediaError);
  });

  it('converts to AAC mono in MP4 with the index first, reporting progress', async () => {
    const target = join(dir, 'out.m4a');
    const seen: number[] = [];
    await transcodeAudio({
      bins,
      source: join(dir, 'tone.mp3'),
      target,
      durationMs: 3_000,
      timeoutMs: 60_000,
      onProgress: (percent) => seen.push(percent),
    });
    const streams = await runProcess(
      bins.ffprobe,
      [
        '-v',
        'error',
        '-show_entries',
        'stream=codec_name,channels',
        '-of',
        'csv=p=0',
        target,
      ],
      { timeoutMs: 10_000 },
    );
    expect(streams.stdout.trim()).toBe('aac,1');
    expect(seen.length).toBeGreaterThan(0);
    expect(Math.max(...seen)).toBeLessThanOrEqual(99);
    const bytes = (await import('node:fs')).readFileSync(target);
    // faststart: the "moov" index comes before the "mdat" data, so playback starts at once.
    expect(bytes.indexOf('moov')).toBeLessThan(bytes.indexOf('mdat'));
  });

  it('fails a conversion ffmpeg cannot do, with its message', async () => {
    const run = transcodeAudio({
      bins,
      source: join(dir, 'missing.mp3'),
      target: join(dir, 'never.m4a'),
      durationMs: 1_000,
      timeoutMs: 60_000,
      onProgress: () => undefined,
    });
    await expect(run).rejects.toThrow(/ffmpeg exited with/);
  });
});
