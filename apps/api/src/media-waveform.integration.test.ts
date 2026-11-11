import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import type { MediaWaveform, WaveformJob } from '@kb-chat/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { closeApp } from '../test/ai-app-harness.js';
import {
  member,
  readyItem,
  startMedia,
  worker,
  type Media,
} from '../test/media-harness.js';
import { ffmpegBins, makeToneWithPauses } from '../test/media-tools.js';
import { SqliteWaveformStore } from './adapters/sqlite/sqlite-waveform-store.js';
import { measurePeaks } from './media-worker/waveform.js';

afterEach(closeApp);

async function leaseWaveform(media: Media): Promise<WaveformJob> {
  const leased = await worker(media, '/api/v1/media-worker/jobs/lease', {
    worker: 'vm',
    kinds: ['waveform'],
  });
  expect(leased.statusCode).toBe(200);
  return leased.json();
}

const sendPeaks = (media: Media, job: WaveformJob, peaks: string) =>
  worker(media, `/api/v1/media-worker/jobs/${job.id}/waveform`, {
    worker: 'vm',
    leaseId: job.leaseId,
    version: job.version,
    peaks,
    elapsedMs: 9,
  });

describe('Waveforms (KBC-066, ADR 0029 §4)', () => {
  it('queues the peaks after the conversion and serves them to listeners', async () => {
    const media = await startMedia();
    const item = await readyItem(media);
    const url = `/api/v1/media/${item.id}/waveform`;
    const pending = await media.owner('GET', url);
    expect(pending.json()).toEqual({
      status: 'pending',
      peaksPerSecond: 10,
      peaks: '',
    });
    const job = await leaseWaveform(media);
    expect(job).toMatchObject({ peaksPerSecond: 10, mediaId: item.id });
    const peaks = Buffer.from([0, 128, 255]).toString('base64');
    expect((await sendPeaks(media, job, peaks)).statusCode).toBe(204);
    const ready = await media.owner('GET', url);
    expect(ready.json()).toEqual({
      status: 'ready',
      peaksPerSecond: 10,
      peaks,
    });
  });

  it('needs `media` and sight of the collection', async () => {
    const media = await startMedia();
    const item = await readyItem(media);
    const url = `/api/v1/media/${item.id}/waveform`;
    const noMedia = await member(media, {
      email: 'sem-midia@example.com',
      topics: [item.topic],
      features: ['search'],
    });
    expect((await noMedia.call('GET', url)).statusCode).toBe(403);
    const blind = await member(media, {
      email: 'cego@example.com',
      topics: [],
      features: ['media'],
    });
    expect((await blind.call('GET', url)).statusCode).toBe(404);
  });

  it('refuses a job someone else holds and an unknown version', async () => {
    const media = await startMedia();
    await readyItem(media);
    const job = await leaseWaveform(media);
    const stranger = await sendPeaks(
      media,
      { ...job, leaseId: '00000000-0000-4000-8000-000000000000' },
      '',
    );
    expect(stranger.statusCode).toBe(409);
    const unknown = await sendPeaks(media, { ...job, version: 99 }, '');
    expect(unknown.statusCode).toBe(400);
  });

  it('backfills an older item, one job at a time, and stops once it has peaks', async () => {
    const media = await startMedia();
    await readyItem(media);
    const db = new DatabaseSync(join(media.mediaDir, 'media.db'));
    const store = new SqliteWaveformStore(db);
    const queue = () =>
      store.queueBackfill({
        version: 1,
        jobId: crypto.randomUUID(),
        now: new Date(),
      });
    expect(queue()).toBeNull();
    const job = await leaseWaveform(media);
    expect(queue()).toBeNull();
    await sendPeaks(media, job, '');
    db.exec(`DELETE FROM media_waveforms`);
    expect(queue()).toBe(job.mediaId);
    expect(store.gaveUp(job.mediaId, 1)).toBe(false);
    db.close();
  });

  it('measures a real tone with its pause, far under 20 s per hour (NFR-2)', async () => {
    const media = await startMedia();
    const item = await readyItem(media);
    const bins = ffmpegBins();
    const job = await leaseWaveform(media);
    const source = join(media.started.state, 'pause.mp3');
    const [, pauseAt = 0] = makeToneWithPauses(bins, source, [0.5, 1.5]);
    const started = performance.now();
    const measured = await measurePeaks({
      bins,
      source,
      peaksPerSecond: job.peaksPerSecond,
      timeoutMs: 30_000,
    });
    expect(performance.now() - started).toBeLessThan(5_000);
    await sendPeaks(media, job, measured.toString('base64'));
    const read = await media.owner('GET', `/api/v1/media/${item.id}/waveform`);
    const peaks = [...Buffer.from(read.json<MediaWaveform>().peaks, 'base64')];
    const during = peaks[Math.round(pauseAt / 100) + 7] ?? 255;
    const before = peaks[Math.round(pauseAt / 100) - 5] ?? 0;
    expect(during).toBeLessThan(10);
    expect(before).toBeGreaterThan(50);
  });
});
