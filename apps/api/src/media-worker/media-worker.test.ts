import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { WaveformJob, WorkerJob } from '@kb-chat/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ffmpegBins, makeLongWav, makeTone } from '../../test/media-tools.js';
import { createLogger } from '../logger.js';
import type { MediaJobsApi } from './api-client.js';
import { MediaWorker } from './media-worker.js';

const bins = ffmpegBins();
let dir: string;
let lines: string[];

const aJob = (overrides: Partial<WorkerJob> = {}): WorkerJob => ({
  id: '11111111-1111-4111-8111-111111111111',
  leaseId: '22222222-2222-4222-8222-222222222222',
  kind: 'transcode',
  mediaId: '33333333-3333-4333-8333-333333333333',
  attempt: 1,
  sourcePath: 'tone.mp3',
  targetPath: 'out.m4a',
  leaseMs: 60_000,
  ...overrides,
});

/** A fake API that records what the worker told it. */
function fakeApi(overrides: Partial<MediaJobsApi> = {}) {
  const told: string[] = [];
  const api: MediaJobsApi = {
    lease: async () => null,
    completeCut: async () => true,
    heartbeat: async () => {
      told.push('heartbeat');
      return true;
    },
    complete: async () => {
      told.push('complete');
      return true;
    },
    completeSilences: async (_job, done) => {
      told.push(`silences:${done.intervals.length}`);
      return true;
    },
    completeWaveform: async (_job, done) => {
      told.push(`waveform:${done.peaks.length}`);
      return true;
    },
    fail: async (_job, failure) => {
      told.push(`fail:${failure.failure}`);
      return true;
    },
    ...overrides,
  };
  return { api, told };
}

/** Holds a job open until a heartbeat arrives, whatever the speed of the machine. */
function firstBeat() {
  let heard = () => {};
  const beat = new Promise<void>((resolve) => (heard = resolve));
  return { beat, heard: () => heard() };
}

const workerWith = (
  api: MediaJobsApi,
  extra: { aliveFile?: string; heartbeatMs?: number } = {},
) =>
  new MediaWorker({
    api,
    bins,
    mediaDir: dir,
    log: createLogger('info', {
      write: (line: string) => void lines.push(line),
    }),
    pollMs: 20,
    ...extra,
  });

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'kbchat-worker-'));
  lines = [];
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

// Real ffmpeg: generous limits, as the suite runs in parallel.
describe('MediaWorker', { timeout: 30_000 }, () => {
  it('refuses a job path outside the media folder and reports a failed conversion', async () => {
    const { api, told } = fakeApi();
    await workerWith(api).process(
      aJob({ targetPath: '../escape.m4a' }),
      new AbortController().signal,
    );
    expect(told).toEqual(['fail:conversion-failed']);
    expect(lines.join('')).toContain('outside the media directory');
  });

  it('logs, without crashing, when the failure cannot be reported', async () => {
    const { api } = fakeApi({
      fail: () => Promise.reject(new Error('API down')),
    });
    await workerWith(api).process(
      aJob({ sourcePath: 'missing.mp3' }),
      new AbortController().signal,
    );
    expect(lines.join('')).toContain('could not report the failure');
  });

  const aWaveformJob = (): WaveformJob => ({
    id: 'job-w',
    leaseId: 'lease-w',
    kind: 'waveform',
    mediaId: 'media-1',
    attempt: 1,
    sourcePath: 'tone.mp3',
    leaseMs: 60_000,
    version: 1,
    peaksPerSecond: 10,
  });

  it('measures the peaks of a waveform job (KBC-066)', async () => {
    makeTone(bins, join(dir, 'tone.mp3'), 1);
    const { api, told } = fakeApi();
    await workerWith(api).process(aWaveformJob(), new AbortController().signal);
    expect(told).toHaveLength(1);
    expect(told[0]).toMatch(/^waveform:\d+$/);
  });

  it('reports a waveform it could not measure, so the queue tries again', async () => {
    const { api, told } = fakeApi();
    await workerWith(api).process(aWaveformJob(), new AbortController().signal);
    expect(told).toEqual(['fail:invalid-audio']);
  });

  it('drops the peaks when the lease was lost', async () => {
    makeTone(bins, join(dir, 'tone.mp3'), 1);
    const { api, told } = fakeApi({ completeWaveform: async () => false });
    await workerWith(api).process(aWaveformJob(), new AbortController().signal);
    expect(told).toEqual([]);
    expect(lines.join('')).toContain('lease lost before completion');
  });

  it('drops the result when the API says the lease was lost at completion', async () => {
    makeTone(bins, join(dir, 'tone.mp3'), 1);
    const { api, told } = fakeApi({ complete: async () => false });
    await workerWith(api).process(aJob(), new AbortController().signal);
    expect(told).toEqual([]);
    expect(existsSync(join(dir, 'out.m4a'))).toBe(false);
    expect(lines.join('')).toContain('lease lost before completion');
  });

  it('stops ffmpeg when a heartbeat says the lease was lost', async () => {
    makeLongWav(bins, join(dir, 'tone.mp3'), 1_800);
    const { api, told } = fakeApi({ heartbeat: async () => false });
    await workerWith(api, { heartbeatMs: 30 }).process(
      aJob(),
      new AbortController().signal,
    );
    expect(told).toEqual([]);
    expect(existsSync(join(dir, 'out.m4a'))).toBe(false);
    expect(lines.join('')).toContain('lease lost: stopping the conversion');
  });

  it('reports a measure as having no percentage in its heartbeat', async () => {
    makeTone(bins, join(dir, 'tone.mp3'), 1);
    const percents: (number | null)[] = [];
    const { beat, heard } = firstBeat();
    const { api } = fakeApi({
      heartbeat: async (_job, percent) => {
        percents.push(percent);
        heard();
        return true;
      },
      completeWaveform: async () => {
        await beat;
        return true;
      },
    });
    await workerWith(api, { heartbeatMs: 1 }).process(
      aWaveformJob(),
      new AbortController().signal,
    );
    expect(percents[0]).toBeNull();
  });

  it('reports the percentage of a conversion in its heartbeat', async () => {
    makeTone(bins, join(dir, 'tone.mp3'), 1);
    const percents: (number | null)[] = [];
    const { beat, heard } = firstBeat();
    const { api } = fakeApi({
      heartbeat: async (_job, percent) => {
        percents.push(percent);
        heard();
        return true;
      },
      complete: async () => {
        await beat;
        return true;
      },
    });
    await workerWith(api, { heartbeatMs: 1 }).process(
      aJob(),
      new AbortController().signal,
    );
    expect(percents[0]).toEqual(expect.any(Number));
  });

  it('keeps converting when one heartbeat fails on the network', async () => {
    makeTone(bins, join(dir, 'tone.mp3'), 2);
    let beats = 0;
    const { api, told } = fakeApi({
      heartbeat: async () => {
        beats++;
        if (beats === 1) throw new Error('ECONNRESET');
        return true;
      },
    });
    await workerWith(api, { heartbeatMs: 10 }).process(
      aJob(),
      new AbortController().signal,
    );
    expect(told).toContain('complete');
    expect(lines.join('')).toContain('heartbeat failed');
  });

  it('keeps its alive file fresh during a long conversion (healthcheck)', async () => {
    makeTone(bins, join(dir, 'tone.mp3'), 2);
    const aliveFile = join(dir, 'alive');
    const touches: number[] = [];
    const { api } = fakeApi({
      heartbeat: async () => {
        if (existsSync(aliveFile)) touches.push(statSync(aliveFile).mtimeMs);
        return true;
      },
    });
    // `process` alone never touches the file: only the job's heartbeat does.
    await workerWith(api, { aliveFile, heartbeatMs: 10 }).process(
      aJob(),
      new AbortController().signal,
    );
    expect(existsSync(aliveFile)).toBe(true);
    expect(new Set(touches).size).toBeGreaterThan(1);
  });

  it('touches its alive file on every loop for the healthcheck', async () => {
    const aliveFile = join(dir, 'alive');
    const { api } = fakeApi();
    const shutdown = new AbortController();
    const loop = workerWith(api, { aliveFile }).run(shutdown.signal);
    await expect.poll(() => existsSync(aliveFile)).toBe(true);
    const first = statSync(aliveFile).mtimeMs;
    await expect
      .poll(() => statSync(aliveFile).mtimeMs > first, { timeout: 2_000 })
      .toBe(true);
    shutdown.abort();
    await loop;
  });
});
