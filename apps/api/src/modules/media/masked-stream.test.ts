import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { ffmpegBins } from '../../../test/media-tools.js';
import {
  SampleIndexCache,
  hiddenTagOf,
  insideHidden,
  maskCovers,
  maskPlanOf,
  maskedStream,
} from './masked-stream.js';
import { readSampleIndex, type ReadAt } from './mp4-samples.js';
import { silentAacFrame } from './silent-aac.js';

/** An MP4 made by ffmpeg from lavfi `inputs` with the output `args`. */
function made(inputs: readonly string[], args: readonly string[]): Buffer {
  const dir = mkdtempSync(join(tmpdir(), 'kbchat-mask-'));
  const path = join(dir, 'made.mp4');
  execFileSync(ffmpegBins().ffmpeg, [
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    ...inputs.flatMap((one) => ['-f', 'lavfi', '-i', one]),
    ...args,
    '-f',
    'mp4',
    path,
  ]);
  return readFileSync(path);
}

/** The offset of the first box `type` in `file`, past its 8-byte header. */
function boxAt(file: Buffer, type: string): number {
  const at = file.indexOf(Buffer.from(type, 'latin1'));
  if (at < 4) throw new Error(`no ${type}`);
  return at + 4;
}

/** 30 s of tone as the worker makes it: AAC 64 kbit/s mono, moov first. */
function tone(): Buffer {
  const dir = mkdtempSync(join(tmpdir(), 'kbchat-mask-'));
  const path = join(dir, 'tone.m4a');
  execFileSync(ffmpegBins().ffmpeg, [
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=330:duration=30',
    '-ac',
    '1',
    '-c:a',
    'aac',
    '-b:a',
    '64k',
    '-movflags',
    '+faststart',
    path,
  ]);
  return readFileSync(path);
}

const readerOf =
  (file: Buffer): ReadAt =>
  async (start, length) =>
    file.subarray(start, Math.min(file.length, start + length));

/** ffprobe's packets: pts in seconds and byte position. */
function packets(file: Buffer): { at: number; pos: number }[] {
  const dir = mkdtempSync(join(tmpdir(), 'kbchat-mask-'));
  const path = join(dir, 'probe.m4a');
  writeFileSync(path, file);
  return execFileSync(ffmpegBins().ffprobe, [
    '-v',
    'error',
    '-select_streams',
    'a',
    '-show_entries',
    'packet=pts_time,pos',
    '-of',
    'csv=p=0',
    path,
  ])
    .toString()
    .trim()
    .split('\n')
    .map((line) => {
      const [at, pos] = line.split(',').map(Number);
      return { at: at ?? 0, pos: pos ?? 0 };
    });
}

/** The mean volume (dB) of `seconds` of `file` from `from`, by ffmpeg; throws on a decode error. */
function meanVolume(file: Buffer, from: number, seconds: number): number {
  const dir = mkdtempSync(join(tmpdir(), 'kbchat-mask-'));
  const path = join(dir, 'masked.m4a');
  writeFileSync(path, file);
  const run = spawnSync(ffmpegBins().ffmpeg, [
    '-hide_banner',
    '-xerror',
    '-ss',
    String(from),
    '-t',
    String(seconds),
    '-i',
    path,
    '-af',
    'volumedetect',
    '-f',
    'null',
    '-',
  ]);
  if (run.status !== 0) throw new Error(run.stderr.toString());
  const found = /mean_volume: (-?[\d.]+) dB/.exec(run.stderr.toString());
  return Number(found?.[1] ?? Number.NaN);
}

async function collect(stream: Readable): Promise<Buffer> {
  const parts: Buffer[] = [];
  for await (const part of stream) parts.push(Buffer.from(part as Buffer));
  return Buffer.concat(parts);
}

describe('silent AAC frames (KBC-106)', () => {
  it('fills exactly the size asked, for every size a 64 kbit/s frame takes', () => {
    for (const size of [4, 5, 6, 20, 186, 300, 600, 1500]) {
      const frame = silentAacFrame(size);
      expect(frame.length).toBe(size);
      // A single channel element first: three zero bits.
      expect((frame[0] ?? 0) >> 5).toBe(0);
    }
  });
});

describe('the sample index of an MP4 (KBC-106)', () => {
  it('finds every AAC frame where ffprobe does', async () => {
    const file = tone();
    const index = await readSampleIndex(readerOf(file), file.length);
    expect(index).not.toBeNull();
    const probed = packets(file);
    expect(index?.sizes.length).toBe(probed.length);
    expect([...(index?.offsets ?? [])].slice(0, 50)).toEqual(
      probed.slice(0, 50).map((one) => one.pos),
    );
    const at10 = probed.findIndex((one) => one.at >= 10);
    expect(Math.abs((index?.startsMs[at10] ?? 0) - 10_000)).toBeLessThan(30);
  });

  it('is null for a file that is not an MP4', async () => {
    const junk = Buffer.from('ID3 not an mp4 at all, just bytes');
    expect(await readSampleIndex(readerOf(junk), junk.length)).toBeNull();
  });
});

describe('the masked stream (KBC-106 FR-2)', () => {
  it('silences the frames of a hidden part and leaves the rest byte for byte', async () => {
    const file = tone();
    const index = await readSampleIndex(readerOf(file), file.length);
    if (!index) throw new Error('index expected');
    const plan = maskPlanOf(index, [{ startMs: 10_000, endMs: 20_000 }]);
    expect(plan.runs).toHaveLength(1);
    const run = plan.runs[0];
    if (!run) throw new Error('run expected');
    const masked = await collect(
      maskedStream(
        Readable.from([file.subarray(0, 50_000), file.subarray(50_000)]),
        plan,
        0,
      ),
    );
    expect(masked.length).toBe(file.length);
    expect(
      masked.subarray(0, run.start).equals(file.subarray(0, run.start)),
    ).toBe(true);
    expect(masked.subarray(run.end).equals(file.subarray(run.end))).toBe(true);
    expect(
      masked
        .subarray(run.start, run.end)
        .equals(file.subarray(run.start, run.end)),
    ).toBe(false);
    // ffmpeg decodes the masked file whole, with no error; the hidden part is silence.
    expect(meanVolume(masked, 0, 30)).toBeLessThan(0);
    expect(meanVolume(masked, 12, 6)).toBeLessThan(-80);
    expect(meanVolume(masked, 2, 6)).toBeGreaterThan(-40);
  });

  it('masks from the middle of a frame when a range starts there', async () => {
    const file = tone();
    const index = await readSampleIndex(readerOf(file), file.length);
    if (!index) throw new Error('index expected');
    const plan = maskPlanOf(index, [{ startMs: 10_000, endMs: 20_000 }]);
    const whole = await collect(maskedStream(Readable.from([file]), plan, 0));
    const start = (plan.runs[0]?.start ?? 0) + 7;
    const part = await collect(
      maskedStream(
        Readable.from([file.subarray(start, start + 5000)]),
        plan,
        start,
      ),
    );
    expect(part.equals(whole.subarray(start, start + 5000))).toBe(true);
  });

  it('says a range wholly inside a hidden run, and not one that crosses it', async () => {
    const file = tone();
    const index = await readSampleIndex(readerOf(file), file.length);
    if (!index) throw new Error('index expected');
    const plan = maskPlanOf(index, [{ startMs: 10_000, endMs: 20_000 }]);
    const run = plan.runs[0];
    if (!run) throw new Error('run expected');
    expect(
      insideHidden(plan, { start: run.start + 1, end: run.start + 1 }),
    ).toBe(true);
    expect(
      insideHidden(plan, { start: run.start - 1, end: run.start + 10 }),
    ).toBe(false);
    expect(insideHidden(plan, { start: run.end - 1, end: run.end })).toBe(
      false,
    );
  });

  it('keeps one index per file version, and tags each hidden set apart', async () => {
    const file = tone();
    const cache = new SampleIndexCache();
    let reads = 0;
    const counted: ReadAt = (start, length) => {
      reads++;
      return readerOf(file)(start, length);
    };
    const meta = { path: 'a.m4a', size: file.length, modifiedMs: 1 };
    await cache.indexOf(meta, counted);
    const first = reads;
    await cache.indexOf(meta, counted);
    expect(reads).toBe(first);
    expect(hiddenTagOf([{ startMs: 1, endMs: 2 }])).not.toBe(
      hiddenTagOf([{ startMs: 1, endMs: 3 }]),
    );
  });
});

describe('a file the mask cannot vouch for is no index (KBC-106 review M2, QA-5)', () => {
  const SINE = 'sine=frequency=330:duration=10';
  const AAC = ['-c:a', 'aac', '-b:a', '64k'];
  const indexOf = (file: Buffer) =>
    readSampleIndex(readerOf(file), file.length);

  it('a fragmented MP4 (its samples in moof boxes)', async () => {
    const file = made(
      [SINE],
      [...AAC, '-movflags', 'frag_keyframe+empty_moov'],
    );
    expect(await indexOf(file)).toBeNull();
  });

  it('two sound tracks, or a picture track beside the sound', async () => {
    const two = made([SINE, SINE], [...AAC, '-map', '0:a', '-map', '1:a']);
    expect(await indexOf(two)).toBeNull();
    const video = made(
      [SINE, 'color=c=black:s=64x64:d=10'],
      [...AAC, '-c:v', 'mpeg4'],
    );
    expect(await indexOf(video)).toBeNull();
  });

  it('a time table shorter than the size table', async () => {
    const file = Buffer.from(tone());
    const stts = boxAt(file, 'stts');
    // The first run's sample count, ten samples short.
    const at = stts + 8;
    file.writeUInt32BE(file.readUInt32BE(at) - 10, at);
    expect(await indexOf(file)).toBeNull();
  });

  it('an edit list that starts with an empty edit', async () => {
    const file = Buffer.from(tone());
    const elst = boxAt(file, 'elst');
    const version = file.readUInt8(elst);
    const entry = elst + 8;
    if (version === 1) file.writeBigInt64BE(-1n, entry + 8);
    else file.writeInt32BE(-1, entry + 4);
    expect(await indexOf(file)).toBeNull();
  });

  it('a plan that does not reach the end of a hidden span does not cover it', async () => {
    const file = tone();
    const index = await indexOf(file);
    if (!index) throw new Error('index expected');
    const hidden = [{ startMs: 10_000, endMs: 20_000 }];
    expect(maskCovers(index, maskPlanOf(index, hidden), hidden)).toBe(true);
    expect(maskCovers(index, { frames: [], runs: [] }, hidden)).toBe(false);
    // Past the end of the audio, as far as the audio goes.
    const late = [{ startMs: 25_000, endMs: 90_000 }];
    expect(maskCovers(index, maskPlanOf(index, late), late)).toBe(true);
  });
});
