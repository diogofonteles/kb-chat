import { existsSync, readdirSync, writeFileSync } from 'node:fs';
import { PassThrough } from 'node:stream';
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
  type Started,
} from '../test/ai-app-harness.js';

afterEach(closeApp);

const WORKER = { ...LOCAL, authorization: `Bearer ${MEDIA_WORKER_TOKEN}` };
const AUDIO = Buffer.from('ID3 fake mp3 bytes for the upload test');
const CONVERTED = Buffer.from('0123456789abcdefghij'); // 20 bytes of "AAC"

const aRequest = (overrides: object = {}) => ({
  title: 'Palestra de 1998',
  authorship: 'mestre-laercio',
  fileName: 'palestra.mp3',
  bytes: AUDIO.length,
  ...overrides,
});

interface Media {
  readonly started: Started;
  readonly owner: Call;
  readonly ownerHeaders: Record<string, string>;
  readonly mediaDir: string;
}

async function startMedia(): Promise<Media> {
  const started = await start({ media: true });
  const ownerHeaders = await signIn(started, 'owner@example.com');
  return {
    started,
    owner: caller(started.app, ownerHeaders),
    ownerHeaders,
    mediaDir: join(started.state, 'media'),
  };
}

/** A member who sees `topics` with `features`. */
async function member(
  media: Media,
  grant: { email: string; topics: string[]; features: string[] },
): Promise<{ call: Call; headers: Record<string, string> }> {
  const invited = await media.owner('POST', '/api/v1/people', {
    email: grant.email,
    sendEmail: false,
  });
  await media.owner('PATCH', `/api/v1/people/${invited.json().id}`, {
    topics: grant.topics,
    features: grant.features,
  });
  const headers = await signIn(media.started, grant.email);
  return { call: caller(media.started.app, headers), headers };
}

const upload = (
  media: Media,
  input: { id: string; body: Buffer; headers?: Record<string, string> },
) =>
  media.started.app.inject({
    method: 'PUT',
    url: `/api/v1/media/${input.id}/file`,
    headers: {
      ...(input.headers ?? media.ownerHeaders),
      'content-type': 'application/octet-stream',
    },
    payload: input.body,
  });

/** An item created and uploaded by the owner: waiting in the queue. */
async function queuedItem(media: Media): Promise<MediaItem> {
  const created = await media.owner(
    'POST',
    '/api/v1/topics/hermetismo/media',
    aRequest(),
  );
  expect(created.statusCode).toBe(201);
  const sent = await upload(media, { id: created.json().id, body: AUDIO });
  expect(sent.statusCode).toBe(200);
  return sent.json();
}

const worker = (media: Media, url: string, payload: object) =>
  media.started.app.inject({ method: 'POST', url, headers: WORKER, payload });

async function leaseJob(media: Media): Promise<WorkerJob> {
  const leased = await worker(media, '/api/v1/media-worker/jobs/lease', {
    worker: 'vm',
    kinds: ['transcode'],
  });
  expect(leased.statusCode).toBe(200);
  return leased.json();
}

/** Plays the worker: writes the "converted" file and completes the job. */
async function convert(media: Media, job: WorkerJob) {
  writeFileSync(join(media.mediaDir, job.targetPath), CONVERTED);
  return worker(media, `/api/v1/media-worker/jobs/${job.id}/complete`, {
    worker: 'vm',
    leaseId: job.leaseId,
    durationMs: 180_000,
    bytes: CONVERTED.length,
  });
}

async function readyItem(media: Media): Promise<MediaItem> {
  const item = await queuedItem(media);
  const done = await convert(media, await leaseJob(media));
  expect(done.statusCode).toBe(204);
  return { ...item, status: 'ready' };
}

describe('Media library: upload (KBC-034)', () => {
  it('says the media library is on in /me', async () => {
    const media = await startMedia();
    expect((await media.owner('GET', '/api/v1/me')).json().media).toBe(true);
  });

  it('creates an item, receives its file and queues it (AC-1, FR-2)', async () => {
    const media = await startMedia();
    const created = await media.owner(
      'POST',
      '/api/v1/topics/hermetismo/media',
      aRequest(),
    );
    expect(created.json()).toMatchObject({
      topic: 'hermetismo',
      title: 'Palestra de 1998',
      authorship: 'mestre-laercio',
      status: 'uploading',
      canRetry: false,
    });
    const sent = await upload(media, { id: created.json().id, body: AUDIO });
    expect(sent.json()).toMatchObject({ status: 'queued' });
    const listed = await media.owner('GET', '/api/v1/topics/hermetismo/media');
    expect(listed.json().items.map((item: MediaItem) => item.status)).toEqual([
      'queued',
    ]);
    expect(
      existsSync(
        join(media.mediaDir, 'uploads', `${created.json().id}.upload`),
      ),
    ).toBe(true);
  });

  it.each([
    [{ bytes: 500 * 1024 * 1024 + 1 }, 'a file over 500 MB'],
    [{ fileName: 'apostila.pdf' }, 'a file that is not audio'],
    [{ title: '   ' }, 'a blank title'],
    [{ authorship: 'sintese' }, 'an authorship media cannot have'],
  ])('refuses %o: %s (AC-8)', async (overrides, reason) => {
    expect(reason).not.toBe('');
    const media = await startMedia();
    const refused = await media.owner(
      'POST',
      '/api/v1/topics/hermetismo/media',
      aRequest(overrides),
    );
    expect(refused.statusCode).toBe(400);
    expect(refused.json().error.code).toBe('VALIDATION_FAILED');
  });

  it('refuses a file larger or smaller than announced, and keeps waiting', async () => {
    const media = await startMedia();
    const created = await media.owner(
      'POST',
      '/api/v1/topics/hermetismo/media',
      aRequest(),
    );
    const id = created.json().id;
    const larger = await upload(media, {
      id,
      body: Buffer.concat([AUDIO, AUDIO]),
    });
    expect(larger.statusCode).toBe(413);
    expect(larger.json().error.code).toBe('PAYLOAD_TOO_LARGE');
    const smaller = await upload(media, { id, body: AUDIO.subarray(0, 5) });
    expect(smaller.statusCode).toBe(400);
    expect(
      (await media.owner('GET', `/api/v1/media/${id}`)).json().status,
    ).toBe('uploading');
    expect((await upload(media, { id, body: AUDIO })).statusCode).toBe(200);
  });

  it('refuses a second upload of the same item and a JSON body', async () => {
    const media = await startMedia();
    const item = await queuedItem(media);
    const again = await upload(media, { id: item.id, body: AUDIO });
    expect(again.statusCode).toBe(409);
    expect(again.json().error.code).toBe('MEDIA_CONFLICT');
    const json = await media.owner('PUT', `/api/v1/media/${item.id}/file`, {
      a: 1,
    });
    expect(json.statusCode).toBe(400);
  });

  it('lets only who created the item send its file', async () => {
    const media = await startMedia();
    const uploader = await member(media, {
      email: 'ana@example.com',
      topics: ['hermetismo'],
      features: ['search', 'media', 'media-upload'],
    });
    const created = await media.owner(
      'POST',
      '/api/v1/topics/hermetismo/media',
      aRequest(),
    );
    const sent = await upload(media, {
      id: created.json().id,
      body: AUDIO,
      headers: uploader.headers,
    });
    expect(sent.statusCode).toBe(404);
  });
});

describe('Media library: collections and races', () => {
  it('refuses a collection that does not exist, even to a master', async () => {
    const media = await startMedia();
    const created = await media.owner(
      'POST',
      '/api/v1/topics/nao-existe/media',
      aRequest(),
    );
    expect(created.statusCode).toBe(404);
    expect(created.json().error.code).toBe('TOPIC_NOT_FOUND');
    expect(
      (await media.owner('GET', '/api/v1/topics/nao-existe/media')).statusCode,
    ).toBe(404);
  });

  it('answers 404 and keeps no bytes when the item is removed while its file arrives', async () => {
    const media = await startMedia();
    const created = (
      await media.owner('POST', '/api/v1/topics/hermetismo/media', aRequest())
    ).json();
    const body = new PassThrough();
    const sending = media.started.app.inject({
      method: 'PUT',
      url: `/api/v1/media/${created.id}/file`,
      headers: {
        ...media.ownerHeaders,
        'content-type': 'application/octet-stream',
      },
      payload: body,
    });
    body.write(AUDIO.subarray(0, 10));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(
      (await media.owner('DELETE', `/api/v1/media/${created.id}`)).statusCode,
    ).toBe(204);
    body.end(AUDIO.subarray(10));
    const sent = await sending;
    expect(sent.statusCode).toBe(404);
    expect(readdirSync(join(media.mediaDir, 'uploads'))).toEqual([]);
  });

  it('limits how many items one client creates per minute', async () => {
    const media = await startMedia();
    const answers: number[] = [];
    for (let i = 0; i < 31; i++)
      answers.push(
        (
          await media.owner(
            'POST',
            '/api/v1/topics/hermetismo/media',
            aRequest(),
          )
        ).statusCode,
      );
    expect(answers.slice(0, 30).every((code) => code === 201)).toBe(true);
    expect(answers[30]).toBe(429);
  });
});

describe('Media library: access (BR-1, BR-2)', () => {
  it('forbids every media route without "Ouvir mídia", even seeing the collection', async () => {
    const media = await startMedia();
    const item = await readyItem(media);
    const searcher = await member(media, {
      email: 'busca@example.com',
      topics: ['hermetismo'],
      features: ['search', 'research'],
    });
    for (const url of [
      '/api/v1/topics/hermetismo/media',
      `/api/v1/media/${item.id}`,
      `/api/v1/media/${item.id}/stream`,
    ]) {
      const refused = await searcher.call('GET', url);
      expect(refused.statusCode).toBe(403);
      expect(refused.json().error.code).toBe('FORBIDDEN');
    }
  });

  it('forbids uploading without media-upload, even with media (AC-4)', async () => {
    const media = await startMedia();
    const reader = await member(media, {
      email: 'leitor@example.com',
      topics: ['hermetismo'],
      features: ['search', 'media'],
    });
    const refused = await reader.call(
      'POST',
      '/api/v1/topics/hermetismo/media',
      aRequest(),
    );
    expect(refused.statusCode).toBe(403);
    expect(
      (await reader.call('GET', '/api/v1/topics/hermetismo/media')).statusCode,
    ).toBe(200);
  });

  it('lets a member with media-upload upload to a collection they see', async () => {
    const media = await startMedia();
    const uploader = await member(media, {
      email: 'ana@example.com',
      topics: ['hermetismo'],
      features: ['search', 'media', 'media-upload'],
    });
    const created = await uploader.call(
      'POST',
      '/api/v1/topics/hermetismo/media',
      aRequest(),
    );
    expect(created.statusCode).toBe(201);
    expect(created.json().canRetry).toBe(false);
    const elsewhere = await uploader.call(
      'POST',
      '/api/v1/topics/alquimia/media',
      aRequest(),
    );
    expect(elsewhere.statusCode).toBe(404);
  });

  it('hides the list, the item and the stream of a collection one cannot see (AC-3)', async () => {
    const media = await startMedia();
    const item = await readyItem(media);
    const outsider = await member(media, {
      email: 'fora@example.com',
      topics: ['alquimia'],
      features: ['search', 'media'],
    });
    expect(
      (await outsider.call('GET', '/api/v1/topics/hermetismo/media'))
        .statusCode,
    ).toBe(404);
    for (const url of [
      `/api/v1/media/${item.id}`,
      `/api/v1/media/${item.id}/stream`,
    ]) {
      const hidden = await outsider.call('GET', url);
      expect(hidden.statusCode).toBe(404);
      expect(hidden.json().error.code).toBe('MEDIA_NOT_FOUND');
    }
  });

  it('asks for a session on every media route', async () => {
    const media = await startMedia();
    const anonymous = await media.started.app.inject({
      method: 'GET',
      url: '/api/v1/topics/hermetismo/media',
      headers: LOCAL,
    });
    expect(anonymous.statusCode).toBe(401);
  });
});

describe('Media library: worker protocol (FR-3, FR-4)', () => {
  it('refuses a worker without the token', async () => {
    const media = await startMedia();
    for (const authorization of [
      '',
      'Bearer wrong-token',
      `Basic ${MEDIA_WORKER_TOKEN}`,
    ]) {
      const refused = await media.started.app.inject({
        method: 'POST',
        url: '/api/v1/media-worker/jobs/lease',
        headers: { ...LOCAL, authorization },
        payload: { worker: 'vm', kinds: ['transcode'] },
      });
      expect(refused.statusCode).toBe(401);
    }
  });

  it('answers 204 when there is nothing to do', async () => {
    const media = await startMedia();
    const empty = await worker(media, '/api/v1/media-worker/jobs/lease', {
      worker: 'vm',
      kinds: ['transcode'],
    });
    expect(empty.statusCode).toBe(204);
  });

  it('leases, reports progress and completes a conversion (AC-1)', async () => {
    const media = await startMedia();
    const item = await queuedItem(media);
    const job = await leaseJob(media);
    expect(job).toMatchObject({
      kind: 'transcode',
      mediaId: item.id,
      attempt: 1,
      sourcePath: `uploads/${item.id}.upload`,
    });
    const beat = await worker(
      media,
      `/api/v1/media-worker/jobs/${job.id}/heartbeat`,
      {
        worker: 'vm',
        leaseId: job.leaseId,
        progress: 40,
      },
    );
    expect(beat.statusCode).toBe(204);
    expect(
      (await media.owner('GET', `/api/v1/media/${item.id}`)).json(),
    ).toMatchObject({
      status: 'processing',
      progress: 40,
    });
    expect((await convert(media, job)).statusCode).toBe(204);
    expect(
      (await media.owner('GET', `/api/v1/media/${item.id}`)).json(),
    ).toMatchObject({
      status: 'ready',
      progress: null,
      durationMs: 180_000,
      bytes: CONVERTED.length,
    });
    // BR-4: the upload is gone; only the converted copy stays.
    expect(existsSync(join(media.mediaDir, job.sourcePath))).toBe(false);
    expect(existsSync(join(media.mediaDir, 'audio', `${item.id}.m4a`))).toBe(
      true,
    );
  });

  it('refuses a completion whose file is missing or of another size', async () => {
    const media = await startMedia();
    await queuedItem(media);
    const job = await leaseJob(media);
    const missing = await worker(
      media,
      `/api/v1/media-worker/jobs/${job.id}/complete`,
      {
        worker: 'vm',
        leaseId: job.leaseId,
        durationMs: 1,
        bytes: 20,
      },
    );
    expect(missing.statusCode).toBe(400);
    writeFileSync(join(media.mediaDir, job.targetPath), CONVERTED);
    const wrongSize = await worker(
      media,
      `/api/v1/media-worker/jobs/${job.id}/complete`,
      {
        worker: 'vm',
        leaseId: job.leaseId,
        durationMs: 1,
        bytes: 21,
      },
    );
    expect(wrongSize.statusCode).toBe(400);
  });

  it('answers 409 to a worker that lost its lease', async () => {
    const media = await startMedia();
    await queuedItem(media);
    const job = await leaseJob(media);
    const stranger = { worker: 'vm', leaseId: crypto.randomUUID() };
    const beat = await worker(
      media,
      `/api/v1/media-worker/jobs/${job.id}/heartbeat`,
      {
        ...stranger,
        progress: 1,
      },
    );
    expect(beat.statusCode).toBe(409);
    const failed = await worker(
      media,
      `/api/v1/media-worker/jobs/${job.id}/fail`,
      {
        ...stranger,
        failure: 'conversion-failed',
        detail: 'x',
      },
    );
    expect(failed.statusCode).toBe(409);
  });

  it('fails an invalid file at once and offers no retry (AC-6)', async () => {
    const media = await startMedia();
    const item = await queuedItem(media);
    const job = await leaseJob(media);
    await worker(media, `/api/v1/media-worker/jobs/${job.id}/fail`, {
      worker: 'vm',
      leaseId: job.leaseId,
      failure: 'invalid-audio',
      detail: 'ffprobe found no audio stream',
    });
    const failed = (
      await media.owner('GET', `/api/v1/media/${item.id}`)
    ).json();
    expect(failed).toMatchObject({
      status: 'failed',
      failure: 'invalid-audio',
      canRetry: false,
    });
    const retry = await media.owner('POST', `/api/v1/media/${item.id}/retry`);
    expect(retry.statusCode).toBe(409);
    // BR-4: nothing could ever use a bad file, so its original is gone.
    expect(existsSync(join(media.mediaDir, job.sourcePath))).toBe(false);
  });

  it('gives up after the fourth crash and lets a master retry (AC-5, FR-7)', async () => {
    const media = await startMedia();
    const item = await queuedItem(media);
    for (let attempt = 1; attempt <= 4; attempt++) {
      const job = await leaseJob(media);
      expect(job.attempt).toBe(attempt);
      await worker(media, `/api/v1/media-worker/jobs/${job.id}/fail`, {
        worker: 'vm',
        leaseId: job.leaseId,
        failure: 'conversion-failed',
        detail: 'ffmpeg exited with 1',
      });
    }
    const failed = (
      await media.owner('GET', `/api/v1/media/${item.id}`)
    ).json();
    expect(failed).toMatchObject({
      status: 'failed',
      failure: 'conversion-failed',
      canRetry: true,
    });
    const retried = await media.owner('POST', `/api/v1/media/${item.id}/retry`);
    expect(retried.json()).toMatchObject({ status: 'queued', failure: null });
    expect((await leaseJob(media)).attempt).toBe(1);
  });
});

describe('Media library: streaming with Range (AC-2, FR-5)', () => {
  const stream = (
    media: Media,
    id: string,
    headers: Record<string, string> = {},
  ) =>
    media.started.app.inject({
      method: 'GET',
      url: `/api/v1/media/${id}/stream`,
      headers: { ...media.ownerHeaders, ...headers },
    });

  it('sends the whole file with Accept-Ranges and an entity tag', async () => {
    const media = await startMedia();
    const item = await readyItem(media);
    const full = await stream(media, item.id);
    expect(full.statusCode).toBe(200);
    expect(full.rawPayload.equals(CONVERTED)).toBe(true);
    expect(full.headers).toMatchObject({
      'accept-ranges': 'bytes',
      'content-type': 'audio/mp4',
      'content-length': String(CONVERTED.length),
    });
    expect(full.headers['etag']).toMatch(/^"[^"]+"$/);
  });

  it.each([
    ['bytes=0-0', 0, 0],
    ['bytes=5-9', 5, 9],
    ['bytes=15-', 15, 19],
    ['bytes=-4', 16, 19],
  ])(
    'answers %s with 206 and exactly those bytes',
    async (range, start, end) => {
      const media = await startMedia();
      const item = await readyItem(media);
      const part = await stream(media, item.id, { range });
      expect(part.statusCode).toBe(206);
      expect(part.headers['content-range']).toBe(`bytes ${start}-${end}/20`);
      expect(part.headers['content-length']).toBe(String(end - start + 1));
      expect(part.rawPayload.equals(CONVERTED.subarray(start, end + 1))).toBe(
        true,
      );
    },
  );

  it('answers 416 for a range past the end', async () => {
    const media = await startMedia();
    const item = await readyItem(media);
    const past = await stream(media, item.id, { range: 'bytes=20-' });
    expect(past.statusCode).toBe(416);
    expect(past.headers['content-range']).toBe('bytes */20');
  });

  it('sends the whole file when If-Range names an older version', async () => {
    const media = await startMedia();
    const item = await readyItem(media);
    const etag = String((await stream(media, item.id)).headers['etag']);
    const same = await stream(media, item.id, {
      range: 'bytes=0-1',
      'if-range': etag,
    });
    expect(same.statusCode).toBe(206);
    const stale = await stream(media, item.id, {
      range: 'bytes=0-1',
      'if-range': '"old"',
    });
    expect(stale.statusCode).toBe(200);
  });

  it('answers HEAD with the headers only', async () => {
    const media = await startMedia();
    const item = await readyItem(media);
    const head = await media.started.app.inject({
      method: 'HEAD',
      url: `/api/v1/media/${item.id}/stream`,
      headers: media.ownerHeaders,
    });
    expect(head.statusCode).toBe(200);
    expect(head.headers['content-length']).toBe('20');
    expect(head.rawPayload.length).toBe(0);
  });

  it('refuses to stream an item that is not converted yet', async () => {
    const media = await startMedia();
    const item = await queuedItem(media);
    const early = await stream(media, item.id);
    expect(early.statusCode).toBe(409);
    expect(early.json().error.code).toBe('MEDIA_NOT_READY');
  });
});

describe('Media library: removal (AC-13, FR-8)', () => {
  it('removes the item, its file and its stream for everyone', async () => {
    const media = await startMedia();
    const item = await readyItem(media);
    const removed = await media.owner('DELETE', `/api/v1/media/${item.id}`);
    expect(removed.statusCode).toBe(204);
    expect(existsSync(join(media.mediaDir, 'audio', `${item.id}.m4a`))).toBe(
      false,
    );
    expect(
      (await media.owner('GET', `/api/v1/media/${item.id}/stream`)).statusCode,
    ).toBe(404);
    expect(
      (await media.owner('GET', '/api/v1/topics/hermetismo/media')).json()
        .items,
    ).toEqual([]);
  });

  it('lets only masters remove or retry', async () => {
    const media = await startMedia();
    const item = await readyItem(media);
    const uploader = await member(media, {
      email: 'ana@example.com',
      topics: ['hermetismo'],
      features: ['search', 'media', 'media-upload'],
    });
    expect(
      (await uploader.call('DELETE', `/api/v1/media/${item.id}`)).statusCode,
    ).toBe(403);
    expect(
      (await uploader.call('POST', `/api/v1/media/${item.id}/retry`))
        .statusCode,
    ).toBe(403);
  });

  it('makes a worker that was converting a removed item drop its work', async () => {
    const media = await startMedia();
    const item = await queuedItem(media);
    const job = await leaseJob(media);
    await media.owner('DELETE', `/api/v1/media/${item.id}`);
    const beat = await worker(
      media,
      `/api/v1/media-worker/jobs/${job.id}/heartbeat`,
      {
        worker: 'vm',
        leaseId: job.leaseId,
        progress: 50,
      },
    );
    expect(beat.statusCode).toBe(409);
    expect((await convert(media, job)).statusCode).toBe(409);
  });
});

describe('Media library: cancelling an upload', () => {
  it('lets the uploader remove their own item while it is uploading, and only then', async () => {
    const media = await startMedia();
    const uploader = await member(media, {
      email: 'ana@example.com',
      topics: ['hermetismo'],
      features: ['search', 'media', 'media-upload'],
    });
    const other = await member(media, {
      email: 'bia@example.com',
      topics: ['hermetismo'],
      features: ['search', 'media', 'media-upload'],
    });
    const created = (
      await uploader.call('POST', '/api/v1/topics/hermetismo/media', aRequest())
    ).json();
    expect(
      (await other.call('DELETE', `/api/v1/media/${created.id}`)).statusCode,
    ).toBe(403);
    expect(
      (await uploader.call('DELETE', `/api/v1/media/${created.id}`)).statusCode,
    ).toBe(204);
    const sent = (
      await uploader.call('POST', '/api/v1/topics/hermetismo/media', aRequest())
    ).json();
    await upload(media, {
      id: sent.id,
      body: AUDIO,
      headers: uploader.headers,
    });
    expect(
      (await uploader.call('DELETE', `/api/v1/media/${sent.id}`)).statusCode,
    ).toBe(403);
  });
});

describe('Media library: off (FR-1)', () => {
  it('registers no media route and says media is off', async () => {
    const started = await start();
    const owner = caller(
      started.app,
      await signIn(started, 'owner@example.com'),
    );
    expect(
      (await owner('GET', '/api/v1/topics/hermetismo/media')).statusCode,
    ).toBe(404);
    expect((await owner('GET', '/api/v1/me')).json().media).toBe(false);
  });
});
