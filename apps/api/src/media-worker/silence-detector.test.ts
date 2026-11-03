import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SILENCE_DETECTOR } from '@kb-chat/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ffmpegBins, makeToneWithPauses } from '../../test/media-tools.js';
import {
  SilenceReport,
  detectSilences,
  silenceArgs,
} from './silence-detector.js';

const bins = ffmpegBins();
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'kbchat-silences-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('SilenceReport', () => {
  it('pairs each silence_start with the next silence_end, in ms', () => {
    const report = new SilenceReport();
    for (const line of [
      'size=N/A time=00:00:01.00 bitrate=N/A',
      '[silencedetect @ 0x1] silence_start: 1.0005',
      '[silencedetect @ 0x1] silence_end: 2.25 | silence_duration: 1.2495',
      '[silencedetect @ 0x1] silence_start: 3.25',
      '[silencedetect @ 0x1] silence_end: 6.25 | silence_duration: 3',
    ])
      report.read(line);
    expect(report.intervals(10_000)).toEqual([
      { startMs: 1_001, endMs: 2_250 },
      { startMs: 3_250, endMs: 6_250 },
    ]);
  });

  it('closes a pause still open at the end of the file at the known length', () => {
    const report = new SilenceReport();
    report.read('[silencedetect @ 0x1] silence_start: 8');
    expect(report.intervals(9_500)).toEqual([{ startMs: 8_000, endMs: 9_500 }]);
  });

  it('ignores an end with no start, a negative start and an open pause of unknown length', () => {
    const report = new SilenceReport();
    report.read('[silencedetect @ 0x1] silence_end: 2 | silence_duration: 1');
    report.read('[silencedetect @ 0x1] silence_start: -0.002');
    report.read(
      '[silencedetect @ 0x1] silence_end: 1.5 | silence_duration: 1.5',
    );
    report.read('[silencedetect @ 0x1] silence_start: 4');
    expect(report.intervals(null)).toEqual([{ startMs: 0, endMs: 1_500 }]);
  });
});

describe('SilenceReport with the numbers older ffmpeg prints (review R1)', () => {
  it('reads scientific notation, as FFmpeg 5.1 prints a pause at the very start', () => {
    const report = new SilenceReport();
    report.read('[silencedetect @ 0x1] silence_start: 2.08333e-05');
    report.read(
      '[silencedetect @ 0x1] silence_end: 2.5 | silence_duration: 2.49998',
    );
    report.read('[silencedetect @ 0x1] silence_start: 1.23457E+04');
    report.read(
      '[silencedetect @ 0x1] silence_end: 12350 | silence_duration: 4.3',
    );
    expect(report.intervals(20_000_000)).toEqual([
      { startMs: 0, endMs: 2_500 },
      { startMs: 12_345_700, endMs: 12_350_000 },
    ]);
  });

  it.each(['nan', 'inf', '-inf', '1.2.3', 'abc'])(
    'drops a pause whose start reads %s',
    (value) => {
      const report = new SilenceReport();
      report.read(`[silencedetect @ 0x1] silence_start: ${value}`);
      report.read('[silencedetect @ 0x1] silence_end: 3 | silence_duration: 1');
      expect(report.intervals(10_000)).toEqual([]);
    },
  );

  it.each(['nan', 'inf', '1.2.3'])(
    'drops a pause whose end reads %s, and the next pause still counts',
    (value) => {
      const report = new SilenceReport();
      report.read('[silencedetect @ 0x1] silence_start: 1');
      report.read(
        `[silencedetect @ 0x1] silence_end: ${value} | silence_duration: 1`,
      );
      report.read('[silencedetect @ 0x1] silence_start: 5');
      report.read(
        '[silencedetect @ 0x1] silence_end: 6.5 | silence_duration: 1.5',
      );
      expect(report.intervals(10_000)).toEqual([
        { startMs: 5_000, endMs: 6_500 },
      ]);
    },
  );
});

describe(
  'detectSilences with real ffmpeg (KBC-044 FR-1)',
  { timeout: 30_000 },
  () => {
    it('uses −35 dB and 1.0 s on the audio only', () => {
      expect(silenceArgs('a.m4a', SILENCE_DETECTOR)).toContain(
        'silencedetect=noise=-35dB:d=1',
      );
    });

    it('finds only the pauses of 1.0 s or more, within 100 ms (AC-1)', async () => {
      const source = join(dir, 'pauses.mp3');
      const starts = makeToneWithPauses(bins, source, [0.5, 1.2, 3]);
      const found = await detectSilences({
        bins,
        source,
        detector: SILENCE_DETECTOR,
        durationMs: null,
        timeoutMs: 60_000,
      });
      expect(found).toHaveLength(2);
      const [short, long] = found;
      expect(Math.abs((short?.startMs ?? 0) - (starts[1] ?? 0))).toBeLessThan(
        100,
      );
      expect(
        Math.abs((short?.endMs ?? 0) - (starts[1] ?? 0) - 1_200),
      ).toBeLessThan(100);
      expect(Math.abs((long?.startMs ?? 0) - (starts[2] ?? 0))).toBeLessThan(
        100,
      );
      expect(
        Math.abs((long?.endMs ?? 0) - (starts[2] ?? 0) - 3_000),
      ).toBeLessThan(100);
    });

    it('fails when ffmpeg cannot read the file', async () => {
      await expect(
        detectSilences({
          bins,
          source: join(dir, 'missing.m4a'),
          detector: SILENCE_DETECTOR,
          durationMs: null,
          timeoutMs: 60_000,
        }),
      ).rejects.toThrow(/silencedetect exited/);
    });
  },
);
