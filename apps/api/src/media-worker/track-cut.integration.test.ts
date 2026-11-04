import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ffmpegBins } from '../../test/media-tools.js';
import { AUDIO_RENDITION_ARGS, cutAudio, probe } from './ffmpeg.js';

const bins = ffmpegBins();
const HOUR_S = 3_600;
const TRACKS = 12;
/** NFR-3: at most this far from what was asked. */
const LIMIT_MS = 50;

let dir = '';
let source = '';

/** A file's packets from `start` seconds: their time and size. */
function packets(path: string, start: number, count: number) {
  const printed = execFileSync(bins.ffprobe, [
    '-v',
    'error',
    '-select_streams',
    'a:0',
    '-read_intervals',
    `${start}%+#${count}`,
    '-show_entries',
    'packet=pts_time,size',
    '-of',
    'csv=p=0',
    path,
  ]).toString();
  return printed
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [time, size] = line.split(',');
      return { timeMs: Number(time) * 1000, size: Number(size) };
    });
}

async function cut(startMs: number, endMs: number, name: string) {
  const target = join(dir, `${name}.m4a`);
  await cutAudio({ bins, source, target, startMs, endMs });
  const { durationMs, hasAudio } = await probe(bins, target);
  return { target, durationMs, hasAudio };
}

// The rendition takes seconds to make; everything else here must take far less.
describe(
  'Cutting tracks with real ffmpeg (KBC-068)',
  { timeout: 120_000 },
  () => {
    beforeAll(() => {
      dir = mkdtempSync(join(tmpdir(), 'kbchat-cut-'));
      source = join(dir, 'rendition.m4a');
      execFileSync(bins.ffmpeg, [
        '-hide_banner',
        '-loglevel',
        'error',
        '-y',
        '-f',
        'lavfi',
        '-i',
        `anoisesrc=color=pink:duration=${HOUR_S}:sample_rate=44100:amplitude=0.2`,
        ...AUDIO_RENDITION_ARGS,
        source,
      ]);
    }, 120_000);

    afterAll(() => rmSync(dir, { recursive: true, force: true }));

    it('AC-1, NFR-1, NFR-2, NFR-3: 12 tracks of an hour, in time, in size, on the mark', async () => {
      const length = (HOUR_S * 1000) / TRACKS;
      const started = performance.now();
      let bytes = 0;
      const misses: number[] = [];
      for (let index = 0; index < TRACKS; index++) {
        const startMs = index * length;
        const done = await cut(startMs, startMs + length, `t${index}`);
        bytes += statSync(done.target).size;
        const first = packets(done.target, 0, 1)[0]?.timeMs ?? Infinity;
        misses.push(Math.abs(first), Math.abs(done.durationMs - length));
      }
      const elapsedMs = performance.now() - started;
      expect(elapsedMs).toBeLessThan(60_000);
      expect(bytes).toBeLessThanOrEqual(statSync(source).size * 1.05);
      expect(Math.max(...misses)).toBeLessThanOrEqual(LIMIT_MS);
    });

    it('copies the packets as they are: nothing is re-encoded', async () => {
      const { target } = await cut(600_000, 610_000, 'copied');
      const sizes = (from: readonly { size: number }[]) =>
        from.map((packet) => packet.size).join(',');
      const copied = sizes(packets(target, 0, 200));
      expect(sizes(packets(source, 598, 400))).toContain(copied);
    });

    it('AC-9: a 5 s track and one at the last second, within 50 ms', async () => {
      const short = await cut(1_234_567, 1_239_567, 'short');
      expect(Math.abs(short.durationMs - 5_000)).toBeLessThanOrEqual(LIMIT_MS);
      const endMs = HOUR_S * 1000;
      const last = await cut(endMs - 6_000, endMs, 'last');
      expect(last.hasAudio).toBe(true);
      expect(Math.abs(last.durationMs - 6_000)).toBeLessThanOrEqual(LIMIT_MS);
      const start = await cut(0, 5_000, 'first');
      expect(Math.abs(start.durationMs - 5_000)).toBeLessThanOrEqual(LIMIT_MS);
    });
  },
);
