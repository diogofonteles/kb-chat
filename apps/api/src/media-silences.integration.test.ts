import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type {
  MediaItem,
  MediaSilences,
  SilencesJob,
  VmWorkerJob,
} from '@kb-chat/contracts';
import { DEFAULT_LIBRARY_PREFERENCES } from '@kb-chat/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import {
  LOCAL,
  MEDIA_WORKER_TOKEN,
  caller,
  closeApp,
  signIn,
  start,
  type Call,
} from '../test/ai-app-harness.js';
import {
  member,
  readyItem,
  startMedia,
  worker,
  type Media,
} from '../test/media-harness.js';
import { ffmpegBins, makeToneWithPauses } from '../test/media-tools.js';
import { SqliteSilenceStore } from './adapters/sqlite/sqlite-silence-store.js';
import { createLogger } from './logger.js';
import { HttpMediaJobsApi } from './media-worker/api-client.js';
import { MediaWorker } from './media-worker/media-worker.js';

afterEach(closeApp);

const bins = ffmpegBins();

/* ---------- The routes, with the fake worker of media-harness ---------- */

async function leaseSilences(media: Media): Promise<SilencesJob> {
  const leased = await worker(media, '/api/v1/media-worker/jobs/lease', {
    worker: 'vm',
    kinds: ['silences'],
  });
  expect(leased.statusCode).toBe(200);
  return leased.json();
}

const sendSilences = (media: Media, job: SilencesJob, intervals: object[]) =>
  worker(media, `/api/v1/media-worker/jobs/${job.id}/silences`, {
    worker: 'vm',
    leaseId: job.leaseId,
    detectorVersion: 1,
    intervals,
    elapsedMs: 12,
  });

describe('Silence maps: the API (KBC-044)', () => {
  it('queues the measurement after the conversion and serves the pauses to listeners (FR-1, FR-3)', async () => {
    const media = await startMedia();
    const item = await readyItem(media);
    const pending = await media.owner(
      'GET',
      `/api/v1/media/${item.id}/silences`,
    );
    expect(pending.statusCode).toBe(200);
    expect(pending.json()).toEqual({
      status: 'pending',
      version: null,
      minSilenceMs: 1_000,
      intervals: [],
    });
    const job = await leaseSilences(media);
    expect(job).toMatchObject({
      kind: 'silences',
      mediaId: item.id,
      sourcePath: `audio/${item.id}.m4a`,
      detector: { version: 1, noiseDb: -35, minSilenceMs: 1_000 },
    });
    const done = await sendSilences(media, job, [
      { startMs: 9_000, endMs: 12_000 },
      { startMs: 1_000, endMs: 2_200 },
    ]);
    expect(done.statusCode).toBe(204);
    const listener = await member(media, {
      email: 'ouvinte@example.com',
      topics: ['hermetismo'],
      features: ['media'],
    });
    const ready = await listener.call(
      'GET',
      `/api/v1/media/${item.id}/silences`,
    );
    expect(ready.json()).toEqual({
      status: 'ready',
      version: 1,
      minSilenceMs: 1_000,
      intervals: [
        { startMs: 1_000, endMs: 2_200 },
        { startMs: 9_000, endMs: 12_000 },
      ],
    });
  });

  it('follows the stream’s access: 403 without listening, 404 outside the person’s collections', async () => {
    const media = await startMedia();
    const item = await readyItem(media);
    const reader = await member(media, {
      email: 'leitor@example.com',
      topics: ['hermetismo'],
      features: ['search'],
    });
    const stranger = await member(media, {
      email: 'outra@example.com',
      topics: [],
      features: ['media'],
    });
    const url = `/api/v1/media/${item.id}/silences`;
    expect((await reader.call('GET', url)).statusCode).toBe(403);
    expect((await stranger.call('GET', url)).statusCode).toBe(404);
  });

  it('refuses a map from a lost lease or of another file', async () => {
    const media = await startMedia();
    await readyItem(media);
    const job = await leaseSilences(media);
    const lost = await worker(
      media,
      `/api/v1/media-worker/jobs/${job.id}/silences`,
      {
        worker: 'vm',
        leaseId: crypto.randomUUID(),
        detectorVersion: 1,
        intervals: [],
        elapsedMs: 1,
      },
    );
    expect(lost.statusCode).toBe(409);
    // The fake conversion lasts 180 s: a pause at 10 min is of another file.
    const beyond = await sendSilences(media, job, [
      { startMs: 600_000, endMs: 602_000 },
    ]);
    expect(beyond.statusCode).toBe(400);
    expect((await sendSilences(media, job, [])).statusCode).toBe(204);
  });

  it('leaves the item ready when the measurement fails, and retries it (AC-5)', async () => {
    const media = await startMedia();
    const item = await readyItem(media);
    const first = await leaseSilences(media);
    const failed = await worker(
      media,
      `/api/v1/media-worker/jobs/${first.id}/fail`,
      {
        worker: 'vm',
        leaseId: first.leaseId,
        failure: 'conversion-failed',
        detail: 'silencedetect crashed',
      },
    );
    expect(failed.statusCode).toBe(204);
    const after = (await media.owner('GET', `/api/v1/media/${item.id}`)).json();
    expect(after).toMatchObject({ status: 'ready', failure: null });
    expect(
      (await media.owner('GET', `/api/v1/media/${item.id}/silences`)).json(),
    ).toMatchObject({ status: 'pending' });
    const again = await leaseSilences(media);
    expect(again).toMatchObject({ id: first.id, attempt: 2 });
  });
});

describe('Silence maps given up (review R1)', () => {
  it('says the map failed after the last attempt, and a newer detector measures it again', async () => {
    const media = await startMedia();
    const item = await readyItem(media);
    for (let attempt = 1; attempt <= 4; attempt++) {
      const job = await leaseSilences(media);
      expect(job.attempt).toBe(attempt);
      await worker(media, `/api/v1/media-worker/jobs/${job.id}/fail`, {
        worker: 'vm',
        leaseId: job.leaseId,
        failure: 'conversion-failed',
        detail: 'silencedetect crashed',
      });
    }
    expect(
      (await media.owner('GET', `/api/v1/media/${item.id}/silences`)).json(),
    ).toMatchObject({ status: 'failed', intervals: [] });
    const db = new DatabaseSync(join(media.mediaDir, 'media.db'));
    const store = new SqliteSilenceStore(db);
    const queue = (detectorVersion: number) =>
      store.queueBackfill({
        detectorVersion,
        jobId: crypto.randomUUID(),
        now: new Date(),
      });
    expect(queue(1)).toBeNull();
    expect(queue(2)).toBe(item.id);
    db.close();
  });
});

describe('Silence skipping preference (KBC-044 BR-2)', () => {
  it('starts off, is kept on the account, and a client that does not send it keeps it', async () => {
    const media = await startMedia();
    const base = {
      speed: 1,
      showRemaining: true,
      skipBackSec: 15,
      skipForwardSec: 30,
    };
    expect(
      (await media.owner('GET', '/api/v1/media/preferences')).json(),
    ).toEqual({ ...base, skipSilences: false, ...DEFAULT_LIBRARY_PREFERENCES });
    await media.owner('PUT', '/api/v1/media/preferences', {
      ...base,
      skipSilences: true,
    });
    const older = await media.owner('PUT', '/api/v1/media/preferences', {
      ...base,
      speed: 1.5,
    });
    expect(older.json()).toEqual({
      ...base,
      speed: 1.5,
      skipSilences: true,
      ...DEFAULT_LIBRARY_PREFERENCES,
    });
    expect(
      (await media.owner('GET', '/api/v1/media/preferences')).json(),
    ).toEqual({
      ...base,
      speed: 1.5,
      skipSilences: true,
      ...DEFAULT_LIBRARY_PREFERENCES,
    });
  });
});

/* ---------- The real worker with ffmpeg ---------- */

interface Running {
  readonly owner: Call;
  readonly ownerHeaders: Record<string, string>;
  readonly mediaDir: string;
  readonly state: string;
  readonly baseUrl: string;
  readonly api: HttpMediaJobsApi;
}

async function running(): Promise<Running> {
  const started = await start({ media: true });
  await started.app.listen({ host: '127.0.0.1', port: 0 });
  const { port } = started.app.server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${port}`;
  const ownerHeaders = await signIn(started, 'owner@example.com');
  return {
    owner: caller(started.app, ownerHeaders),
    ownerHeaders,
    mediaDir: join(started.state, 'media'),
    state: started.state,
    baseUrl,
    api: new HttpMediaJobsApi({
      baseUrl,
      token: MEDIA_WORKER_TOKEN,
      worker: 'test-vm',
    }),
  };
}

const workerFor = (env: Running, ffmpeg = bins.ffmpeg) =>
  new MediaWorker({
    api: env.api,
    bins: { ...bins, ffmpeg },
    mediaDir: env.mediaDir,
    log: createLogger('silent'),
    pollMs: 50,
    heartbeatMs: 100,
  });

async function uploadFile(env: Running, file: string): Promise<MediaItem> {
  const body = readFileSync(file);
  const created = await env.owner('POST', '/api/v1/topics/hermetismo/media', {
    title: 'Palestra com pausas',
    author: null,
    fileName: 'palestra.mp3',
    bytes: body.length,
  });
  const response = await fetch(
    `${env.baseUrl}/api/v1/media/${created.json().id}/file`,
    {
      method: 'PUT',
      headers: {
        ...env.ownerHeaders,
        host: LOCAL.host,
        'content-type': 'application/octet-stream',
      },
      body,
    },
  );
  expect(response.status).toBe(200);
  return (await response.json()) as MediaItem;
}

async function leased(env: Running, kind: VmWorkerJob['kind']) {
  const job = await env.api.lease();
  if (job?.kind !== kind) throw new Error(`expected a ${kind} job`);
  return job;
}

const silencesOf = async (env: Running, id: string): Promise<MediaSilences> =>
  (await env.owner('GET', `/api/v1/media/${id}/silences`)).json();

/** The media database the API writes, opened beside it (WAL lets both in). */
const databaseOf = (env: Running) =>
  new DatabaseSync(join(env.mediaDir, 'media.db'));

describe(
  'Silence maps with the real worker and ffmpeg (KBC-044)',
  { timeout: 60_000 },
  () => {
    it('maps only the pauses of 1 s or more after the conversion, within 100 ms (AC-1)', async () => {
      const env = await running();
      const source = join(env.state, 'pauses.mp3');
      const starts = makeToneWithPauses(bins, source, [0.5, 1.2, 3]);
      const item = await uploadFile(env, source);
      const run = new AbortController().signal;
      await workerFor(env).process(await leased(env, 'transcode'), run);
      await workerFor(env).process(await leased(env, 'silences'), run);
      const map = await silencesOf(env, item.id);
      expect(map.status).toBe('ready');
      expect(map.intervals).toHaveLength(2);
      const expected = [
        { startMs: starts[1] ?? 0, endMs: (starts[1] ?? 0) + 1_200 },
        { startMs: starts[2] ?? 0, endMs: (starts[2] ?? 0) + 3_000 },
      ];
      map.intervals.forEach((pause, index) => {
        expect(
          Math.abs(pause.startMs - (expected[index]?.startMs ?? 0)),
        ).toBeLessThan(100);
        expect(
          Math.abs(pause.endMs - (expected[index]?.endMs ?? 0)),
        ).toBeLessThan(100);
      });
    });

    it('keeps the item ready when silencedetect fails, and the job is tried again (AC-5)', async () => {
      const env = await running();
      const source = join(env.state, 'pauses.mp3');
      makeToneWithPauses(bins, source, [1.5]);
      const item = await uploadFile(env, source);
      const run = new AbortController().signal;
      await workerFor(env).process(await leased(env, 'transcode'), run);
      await workerFor(env, '/nonexistent/ffmpeg').process(
        await leased(env, 'silences'),
        run,
      );
      const after = (await env.owner('GET', `/api/v1/media/${item.id}`)).json();
      expect(after.status).toBe('ready');
      expect((await silencesOf(env, item.id)).status).toBe('pending');
      const retry = await leased(env, 'silences');
      expect(retry.attempt).toBe(2);
      await workerFor(env).process(retry, run);
      expect((await silencesOf(env, item.id)).intervals).toHaveLength(1);
    });

    it('backfills three older items, one silences job at a time (AC-6)', async () => {
      const env = await running();
      const run = new AbortController().signal;
      const ids: string[] = [];
      for (const name of ['a', 'b', 'c']) {
        const source = join(env.state, `${name}.mp3`);
        makeToneWithPauses(bins, source, [1.5]);
        ids.push((await uploadFile(env, source)).id);
      }
      // The three conversions first: their silences jobs wait behind them.
      for (const id of ids) {
        const conversion = await leased(env, 'transcode');
        expect(conversion.mediaId).toBe(id);
        await workerFor(env).process(conversion, run);
      }
      // Items converted before KBC-044 had no silences job: drop the ones just queued.
      const db = databaseOf(env);
      db.prepare("DELETE FROM jobs WHERE kind = 'silences'").run();
      const queued = new SqliteSilenceStore(db).queueBackfill({
        detectorVersion: 1,
        jobId: crypto.randomUUID(),
        now: new Date(),
      });
      expect(queued).toBe(ids[0]);
      const waiting = () =>
        Number(
          db
            .prepare(
              `SELECT count(*) AS n FROM jobs WHERE kind = 'silences'
                 AND status IN ('queued', 'leased')`,
            )
            .get()?.['n'],
        );
      for (const id of ids) {
        expect(waiting()).toBe(1);
        const job = await leased(env, 'silences');
        expect(job.mediaId).toBe(id);
        await workerFor(env).process(job, run);
      }
      expect(waiting()).toBe(0);
      for (const id of ids)
        expect((await silencesOf(env, id)).status).toBe('ready');
      db.close();
    });
  },
);
