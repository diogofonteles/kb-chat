import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ffmpegBins } from '../../test/media-tools.js';
import { PeakMeter, measurePeaks, waveformArgs } from './waveform.js';

const samples = (...levels: number[]) => {
  const bytes = Buffer.alloc(levels.length * 2);
  levels.forEach((level, index) => bytes.writeInt16LE(level, index * 2));
  return bytes;
};

describe('PeakMeter (KBC-066)', () => {
  it('keeps the loudest sample of each window, in either direction', () => {
    const meter = new PeakMeter(4_000);
    meter.read(samples(100, -16_384, 0, 32_767));
    expect([...meter.result()]).toEqual([128, 255]);
  });

  it('reads a sample split between two chunks', () => {
    const meter = new PeakMeter(8_000);
    const bytes = samples(-32_768, 16_384);
    meter.read(bytes.subarray(0, 3));
    meter.read(bytes.subarray(3));
    expect([...meter.result()]).toEqual([255, 128]);
  });

  it('counts the last short window and nothing after it', () => {
    const meter = new PeakMeter(10);
    meter.read(samples(32_767));
    expect([...meter.result()]).toEqual([255]);
    expect([...new PeakMeter(10).result()]).toEqual([]);
  });
});

describe('waveformArgs', () => {
  it('decodes to raw mono samples on stdout, audio only', () => {
    const args = waveformArgs('a.m4a');
    expect(args).toContain('s16le');
    expect(args).toContain('-vn');
    expect(args.at(-1)).toBe('pipe:1');
  });
});

describe('measurePeaks when ffmpeg does not finish', () => {
  const bins = ffmpegBins();
  const source = join(mkdtempSync(join(tmpdir(), 'peaks-')), 'missing.m4a');
  const base = { bins, source, peaksPerSecond: 10, timeoutMs: 30_000 };

  it('fails when ffmpeg cannot read the file', async () => {
    await expect(measurePeaks(base)).rejects.toThrow(/ffmpeg exited/);
  });

  it('says so when it was stopped', async () => {
    await expect(
      measurePeaks({ ...base, signal: AbortSignal.abort() }),
    ).rejects.toThrow(/aborted/);
  });

  it('says so when it took too long', async () => {
    const ffmpeg = join(mkdtempSync(join(tmpdir(), 'slow-')), 'ffmpeg');
    writeFileSync(ffmpeg, '#!/bin/sh\nexec sleep 5\n', { mode: 0o755 });
    await expect(
      measurePeaks({ ...base, bins: { ...bins, ffmpeg }, timeoutMs: 50 }),
    ).rejects.toThrow(/timed out/);
  });
});
