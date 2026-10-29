import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import type { MediaItem, WorkerJob } from '@kb-chat/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import {
  LOCAL,
  MEDIA_WORKER_TOKEN,
  caller,
  closeApp,
  signIn,
  start,
  type Call,
} from '../../test/ai-app-harness.js';
import { ffmpegBins, makeLongWav, makeTone } from '../../test/media-tools.js';
import { createLogger } from '../logger.js';
import { HttpMediaJobsApi, type MediaJobsApi } from './api-client.js';
import { MediaWorker } from './media-worker.js';

afterEach(closeApp);

const bins = ffmpegBins();

interface Running {
  readonly owner: Call;
  readonly ownerHeaders: Record<string, string>;
  readonly mediaDir: string;
  readonly state: string;
  readonly api: HttpMediaJobsApi;
  readonly baseUrl: string;
}

/** The real API, listening, with media on, and a worker client pointed at it. */
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

const workerFor = (env: Running, api: MediaJobsApi = env.api) =>
  new MediaWorker({
    api,
    bins,
    mediaDir: env.mediaDir,
    log: createLogger('silent'),
    pollMs: 50,
    heartbeatMs: 100,
  });

/** Uploads `file` through the real routes (POST, then PUT of the bytes). */
async function uploadFile(env: Running, file: string): Promise<MediaItem> {
  const body = readFileSync(file);
  const created = await env.owner('POST', '/api/v1/topics/hermetismo/media', {
    title: 'Palestra de teste',
    authorship: 'outros-autores',
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

const itemOf = async (env: Running, id: string): Promise<MediaItem> =>
  (await env.owner('GET', `/api/v1/media/${id}`)).json();

async function leased(env: Running): Promise<WorkerJob> {
  const job = await env.api.lease();
  if (!job) throw new Error('no job to lease');
  return job;
}

// Real ffmpeg on minutes of audio: generous limits, as the suite runs in parallel.
describe(
  'MediaWorker with the real API and ffmpeg (KBC-034)',
  { timeout: 30_000 },
  () => {
    it('converts an uploaded MP3 into a playable AAC rendition (AC-1, BR-4)', async () => {
      const env = await running();
      const source = join(env.state, 'tone.mp3');
      makeTone(bins, source, 10);
      const item = await uploadFile(env, source);
      expect(item.status).toBe('queued');
      const job = await leased(env);
      await workerFor(env).process(job, new AbortController().signal);
      const ready = await itemOf(env, item.id);
      expect(ready.status).toBe('ready');
      expect(ready.durationMs).toBeGreaterThan(9_900);
      expect(ready.durationMs).toBeLessThan(10_200);
      // BR-4: only the converted copy stays; no work file is left behind.
      expect(existsSync(join(env.mediaDir, job.sourcePath))).toBe(false);
      expect(readdirSync(join(env.mediaDir, 'audio'))).toEqual([
        `${item.id}.m4a`,
      ]);
      const stream = await env.owner('GET', `/api/v1/media/${item.id}/stream`);
      expect(stream.statusCode).toBe(200);
      expect(stream.rawPayload.length).toBe(ready.bytes);
    });

    it('fails a corrupt MP3 as invalid audio, without retries (AC-6)', async () => {
      const env = await running();
      const corrupt = join(env.state, 'corrupt.mp3');
      writeFileSync(
        corrupt,
        Buffer.from('ID3\u0003 this is not really an mp3 '.repeat(50)),
      );
      const item = await uploadFile(env, corrupt);
      await workerFor(env).process(
        await leased(env),
        new AbortController().signal,
      );
      expect(await itemOf(env, item.id)).toMatchObject({
        status: 'failed',
        failure: 'invalid-audio',
        canRetry: false,
      });
      expect(await env.api.lease()).toBeNull();
    });

    it('reports a broken ffmpeg as a conversion failure that will be retried', async () => {
      const env = await running();
      const source = join(env.state, 'tone.mp3');
      makeTone(bins, source, 2);
      const item = await uploadFile(env, source);
      const broken = new MediaWorker({
        api: env.api,
        bins: { ...bins, ffmpeg: '/nonexistent/ffmpeg' },
        mediaDir: env.mediaDir,
        log: createLogger('silent'),
        pollMs: 50,
      });
      await broken.process(await leased(env), new AbortController().signal);
      expect((await itemOf(env, item.id)).status).toBe('queued');
      expect((await leased(env)).attempt).toBe(2);
    });

    it('stops converting and leaves nothing behind when the item is removed', async () => {
      const env = await running();
      const source = join(env.state, 'long.wav');
      makeLongWav(bins, source, 1_800);
      const item = await uploadFile(env, source);
      const job = await leased(env);
      const conversion = workerFor(env).process(
        job,
        new AbortController().signal,
      );
      await new Promise((resolve) => setTimeout(resolve, 150));
      await env.owner('DELETE', `/api/v1/media/${item.id}`);
      await conversion;
      expect(readdirSync(join(env.mediaDir, 'audio'))).toEqual([]);
      expect(
        (await env.owner('GET', `/api/v1/media/${item.id}`)).statusCode,
      ).toBe(404);
    });

    it('stops at shutdown and lets the lease expire back to the queue', async () => {
      const env = await running();
      const source = join(env.state, 'long.wav');
      makeLongWav(bins, source, 1_800);
      const item = await uploadFile(env, source);
      const shutdown = new AbortController();
      const conversion = workerFor(env).process(
        await leased(env),
        shutdown.signal,
      );
      setTimeout(() => shutdown.abort(), 100);
      await conversion;
      expect(readdirSync(join(env.mediaDir, 'audio'))).toEqual([]);
      expect((await itemOf(env, item.id)).status).toBe('processing');
    });

    it('runs the loop: waits while the queue is empty, then converts', async () => {
      const env = await running();
      const shutdown = new AbortController();
      const loop = workerFor(env).run(shutdown.signal);
      const source = join(env.state, 'tone.mp3');
      makeTone(bins, source, 1);
      const item = await uploadFile(env, source);
      await expect
        .poll(async () => (await itemOf(env, item.id)).status, {
          timeout: 15_000,
        })
        .toBe('ready');
      shutdown.abort();
      await loop;
    });

    it('keeps looping when the API is down', async () => {
      const env = await running();
      const failing: MediaJobsApi = {
        lease: () => Promise.reject(new Error('ECONNREFUSED')),
        heartbeat: () => Promise.resolve(true),
        complete: () => Promise.resolve(true),
        fail: () => Promise.resolve(true),
      };
      const shutdown = new AbortController();
      const loop = workerFor(env, failing).run(shutdown.signal);
      await new Promise((resolve) => setTimeout(resolve, 200));
      shutdown.abort();
      await expect(loop).resolves.toBeUndefined();
    });
  },
);
