import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { MEDIA_DEFAULT_QUOTA_BYTES } from '@kb-chat/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { closeApp, type Call } from '../test/ai-app-harness.js';
import {
  AUDIO,
  aRequest,
  convert,
  leaseJob,
  member,
  startMedia,
  type Media,
} from '../test/media-harness.js';

afterEach(closeApp);

const TOPIC_MEDIA = '/api/v1/topics/hermetismo/media';
const HOUR_MS = 3_600_000;
const shaOf = (bytes: Buffer) =>
  createHash('sha256').update(bytes).digest('hex');
const SHA = shaOf(AUDIO);

const partPath = (media: Media, id: string) =>
  join(media.mediaDir, 'uploads', `${id}.upload.part`);

const aCheck = (overrides: object = {}) => ({
  sha256: SHA,
  bytes: AUDIO.length,
  durationMs: 60_000,
  ...overrides,
});

/** Changes a row the way time or a finished conversion would. */
function sql(media: Media, statement: string, ...values: (string | number)[]) {
  const db = new DatabaseSync(join(media.mediaDir, 'media.db'));
  try {
    db.prepare(statement).run(...values);
  } finally {
    db.close();
  }
}

const expireUpload = (media: Media, id: string) =>
  sql(
    media,
    `UPDATE media SET status = 'failed', failure = 'upload-abandoned' WHERE id = ?`,
    id,
  );

/** An item of this person, ready, of that many converted bytes. */
async function fillQuota(media: Media, call: Call, bytes: number) {
  const reply = await call(
    'POST',
    TOPIC_MEDIA,
    aRequest({ author: null, durationMs: 1000, sha256: 'f'.repeat(64) }),
  );
  expect(reply.statusCode).toBe(201);
  sql(
    media,
    `UPDATE media SET status = 'ready', bytes = ?, source_sha256 = NULL WHERE id = ?`,
    Math.round(bytes),
    reply.json().id,
  );
}

const uploadUrl = (id: string) => `/api/v1/media/${id}/upload`;

const offsetOf = (media: Media, id: string) =>
  media.started.app.inject({
    method: 'HEAD',
    url: uploadUrl(id),
    headers: { ...media.ownerHeaders, 'tus-resumable': '1.0.0' },
  });

const patch = (
  media: Media,
  input: {
    id: string;
    offset: number;
    body: Buffer;
    headers?: Record<string, string>;
  },
) =>
  media.started.app.inject({
    method: 'PATCH',
    url: uploadUrl(input.id),
    headers: {
      ...(input.headers ?? media.ownerHeaders),
      'tus-resumable': '1.0.0',
      'upload-offset': String(input.offset),
      'content-type': 'application/offset+octet-stream',
    },
    payload: input.body,
  });

async function created(media: Media, overrides: object = {}): Promise<string> {
  const reply = await media.owner(
    'POST',
    TOPIC_MEDIA,
    aRequest({ sha256: SHA, durationMs: 60_000, ...overrides }),
  );
  expect(reply.statusCode).toBe(201);
  return reply.json().id;
}

describe('Resumable upload (KBC-035, tus core on the item)', () => {
  it('answers the offset, takes parts in order and queues the item on the last byte (FR-2)', async () => {
    const media = await startMedia();
    const id = await created(media);
    const first = await offsetOf(media, id);
    expect(first.statusCode).toBe(204);
    expect(first.headers['upload-offset']).toBe('0');
    expect(first.headers['upload-length']).toBe(String(AUDIO.length));
    expect(first.headers['tus-resumable']).toBe('1.0.0');
    expect(first.headers['cache-control']).toBe('no-store');

    const part = await patch(media, {
      id,
      offset: 0,
      body: AUDIO.subarray(0, 10),
    });
    expect(part.statusCode).toBe(204);
    expect(part.headers['upload-offset']).toBe('10');
    expect((await offsetOf(media, id)).headers['upload-offset']).toBe('10');
    expect((await media.owner('GET', `/api/v1/media/${id}`)).json().status).toBe(
      'uploading',
    );

    const last = await patch(media, {
      id,
      offset: 10,
      body: AUDIO.subarray(10),
    });
    expect(last.statusCode).toBe(204);
    expect(last.headers['upload-offset']).toBe(String(AUDIO.length));
    expect((await media.owner('GET', `/api/v1/media/${id}`)).json().status).toBe(
      'queued',
    );
    expect(
      readFileSync(join(media.mediaDir, 'uploads', `${id}.upload`)),
    ).toEqual(AUDIO);
  });

  it('refuses a part at the wrong offset, without changing what it has (a retry reads HEAD)', async () => {
    const media = await startMedia();
    const id = await created(media);
    await patch(media, { id, offset: 0, body: AUDIO.subarray(0, 10) });
    const wrong = await patch(media, {
      id,
      offset: 4,
      body: AUDIO.subarray(4, 8),
    });
    expect(wrong.statusCode).toBe(409);
    expect(wrong.json().error.code).toBe('MEDIA_CONFLICT');
    expect(statSync(partPath(media, id)).size).toBe(10);
  });

  it('refuses a part past the announced size and keeps what was confirmed', async () => {
    const media = await startMedia();
    const id = await created(media);
    await patch(media, { id, offset: 0, body: AUDIO.subarray(0, 10) });
    const over = await patch(media, {
      id,
      offset: 10,
      body: Buffer.alloc(AUDIO.length),
    });
    expect(over.statusCode).toBe(413);
    expect((await offsetOf(media, id)).headers['upload-offset']).toBe('10');
  });

  it('refuses another content type on a part', async () => {
    const media = await startMedia();
    const id = await created(media);
    const wrong = await media.started.app.inject({
      method: 'PATCH',
      url: uploadUrl(id),
      headers: {
        ...media.ownerHeaders,
        'upload-offset': '0',
        'content-type': 'application/json',
      },
      payload: '{}',
    });
    expect(wrong.statusCode).toBe(415);
  });

  it('starts again when the bytes do not match the hash announced', async () => {
    const media = await startMedia();
    const id = await created(media);
    const corrupt = Buffer.alloc(AUDIO.length, 7);
    const sent = await patch(media, { id, offset: 0, body: corrupt });
    expect(sent.statusCode).toBe(400);
    expect(sent.json().error.details).toEqual({ field: 'sha256' });
    expect((await offsetOf(media, id)).headers['upload-offset']).toBe('0');
    expect(existsSync(partPath(media, id))).toBe(false);
  });

  it('is only for who started it, and 404 for who cannot see it', async () => {
    const media = await startMedia();
    const id = await created(media);
    const other = await member(media, {
      email: 'outra@example.com',
      topics: ['hermetismo'],
      features: ['media', 'media-upload'],
    });
    const refused = await patch(media, {
      id,
      offset: 0,
      body: AUDIO,
      headers: other.headers,
    });
    expect(refused.statusCode).toBe(404);
  });

  it('answers 410 once the upload expired (AC-6)', async () => {
    const media = await startMedia();
    const id = await created(media);
    expireUpload(media, id);
    const head = await offsetOf(media, id);
    expect(head.statusCode).toBe(410);
    const sent = await patch(media, { id, offset: 0, body: AUDIO });
    expect(sent.statusCode).toBe(410);
    expect(sent.json().error.code).toBe('MEDIA_UPLOAD_EXPIRED');
  });
});

describe('Asking before sending (KBC-035 FR-1, FR-3)', () => {
  const check = (media: Media, body: object) =>
    media.owner('POST', `${TOPIC_MEDIA}/check`, body);

  it('says a new file is new', async () => {
    const media = await startMedia();
    const reply = await check(media, aCheck());
    expect(reply.statusCode).toBe(200);
    expect(reply.json()).toEqual({ verdict: 'new' });
  });

  it('names the media already in the collection (AC-2, BR-2)', async () => {
    const media = await startMedia();
    const id = await created(media);
    await patch(media, { id, offset: 0, body: AUDIO });
    const reply = await check(media, aCheck());
    expect(reply.json()).toEqual({
      verdict: 'duplicate',
      media: { id, title: 'Palestra de 1998' },
    });
    const again = await media.owner(
      'POST',
      TOPIC_MEDIA,
      aRequest({ sha256: SHA }),
    );
    expect(again.statusCode).toBe(409);
    expect(again.json().error.code).toBe('MEDIA_DUPLICATE');
    expect(again.json().error.details.media.id).toBe(id);
  });

  it('does not call a file repeated in another collection, nor after a failure', async () => {
    const media = await startMedia();
    const id = await created(media);
    await patch(media, { id, offset: 0, body: AUDIO });
    const elsewhere = await media.owner(
      'POST',
      '/api/v1/topics/alquimia/media/check',
      aCheck(),
    );
    expect(elsewhere.json()).toEqual({ verdict: 'new' });
    const job = await leaseJob(media);
    expect(job.mediaId).toBe(id);
    sql(media, `UPDATE media SET status = 'failed' WHERE id = ?`, id);
    expect((await check(media, aCheck())).json()).toEqual({ verdict: 'new' });
  });

  it('offers to continue an unfinished upload from where it stopped (FR-2)', async () => {
    const media = await startMedia();
    const id = await created(media);
    await patch(media, { id, offset: 0, body: AUDIO.subarray(0, 10) });
    expect((await check(media, aCheck())).json()).toEqual({
      verdict: 'resume',
      media: { id, title: 'Palestra de 1998' },
      offset: 10,
    });
  });

  it('calls someone else unfinished upload a duplicate, never theirs to continue', async () => {
    const media = await startMedia();
    const id = await created(media);
    const other = await member(media, {
      email: 'outra@example.com',
      topics: ['hermetismo'],
      features: ['media', 'media-upload'],
    });
    const reply = await other.call('POST', `${TOPIC_MEDIA}/check`, aCheck());
    expect(reply.json().verdict).toBe('duplicate');
    expect(reply.json().media.id).toBe(id);
  });

  it('says an expired upload expired, and the file can be sent again (AC-6)', async () => {
    const media = await startMedia();
    const id = await created(media);
    expireUpload(media, id);
    expect((await check(media, aCheck())).json()).toEqual({
      verdict: 'expired',
    });
    await created(media);
    expect((await check(media, aCheck())).json().verdict).toBe('resume');
  });

  it('refuses a send over the person quota, before and on create (AC-3, BR-1)', async () => {
    const media = await startMedia();
    const person = await member(media, {
      email: 'cota@example.com',
      topics: ['hermetismo'],
      features: ['media', 'media-upload'],
    });
    const tenHours = aCheck({ durationMs: 10 * HOUR_MS, sha256: 'b'.repeat(64) });
    await fillQuota(media, person.call, 4.9 * 1024 ** 3);
    const reply = await person.call('POST', `${TOPIC_MEDIA}/check`, tenHours);
    expect(reply.json()).toEqual({
      verdict: 'over-quota',
      quotaBytes: MEDIA_DEFAULT_QUOTA_BYTES,
    });
    const refused = await person.call(
      'POST',
      TOPIC_MEDIA,
      aRequest({ ...tenHours, author: null }),
    );
    expect(refused.statusCode).toBe(413);
    expect(refused.json().error).toMatchObject({
      code: 'MEDIA_QUOTA_EXCEEDED',
      details: { quotaBytes: MEDIA_DEFAULT_QUOTA_BYTES },
    });
    const small = await person.call(
      'POST',
      TOPIC_MEDIA,
      aRequest({ author: null, durationMs: 60_000 }),
    );
    expect(small.statusCode).toBe(201);
  });

  it('counts the file size when the length is unknown', async () => {
    const media = await startMedia();
    const person = await member(media, {
      email: 'cota@example.com',
      topics: ['hermetismo'],
      features: ['media', 'media-upload'],
    });
    await fillQuota(media, person.call, 4 * 1024 ** 3);
    const huge = aCheck({ durationMs: null, bytes: 2 * 1024 ** 3 });
    const reply = await person.call('POST', `${TOPIC_MEDIA}/check`, huge);
    expect(reply.json().verdict).toBe('over-quota');
  });

  it('counts uploads still on their way against the quota', async () => {
    const media = await startMedia();
    const person = await member(media, {
      email: 'cota@example.com',
      topics: ['hermetismo'],
      features: ['media', 'media-upload'],
    });
    await fillQuota(media, person.call, 4.9 * 1024 ** 3);
    const threeHours = { durationMs: 3 * HOUR_MS };
    const first = await person.call(
      'POST',
      TOPIC_MEDIA,
      aRequest({ author: null, ...threeHours }),
    );
    expect(first.statusCode).toBe(201);
    const second = await person.call(
      'POST',
      TOPIC_MEDIA,
      aRequest({ author: null, ...threeHours }),
    );
    expect(second.statusCode).toBe(413);
  });

  it('never applies a quota to the owner (AC-4)', async () => {
    const media = await startMedia();
    await fillQuota(media, media.owner, 50 * 1024 ** 3);
    const reply = await check(media, aCheck({ durationMs: 100 * HOUR_MS }));
    expect(reply.json()).toEqual({ verdict: 'new' });
  });

  it('lets a master change a person quota; only a master (BR-1)', async () => {
    const media = await startMedia();
    const person = await member(media, {
      email: 'cota@example.com',
      topics: ['hermetismo'],
      features: ['media', 'media-upload'],
    });
    const list = await media.owner('GET', '/api/v1/people');
    const target = list
      .json()
      .items.find((one: { email: string }) => one.email === 'cota@example.com');
    expect(target.mediaQuotaBytes).toBeNull();
    const quota = 1024 ** 3;
    const changed = await media.owner('PATCH', `/api/v1/people/${target.id}`, {
      mediaQuotaBytes: quota,
    });
    expect(changed.json().mediaQuotaBytes).toBe(quota);
    await fillQuota(media, person.call, 0.95 * quota);
    const reply = await person.call(
      'POST',
      `${TOPIC_MEDIA}/check`,
      aCheck({ durationMs: 2 * HOUR_MS }),
    );
    expect(reply.json()).toEqual({ verdict: 'over-quota', quotaBytes: quota });
    const denied = await person.call('PATCH', `/api/v1/people/${target.id}`, {
      mediaQuotaBytes: 10 * quota,
    });
    expect(denied.statusCode).toBe(403);
  });

  it('counts the converted size, not the estimate, once the item is ready', async () => {
    const media = await startMedia();
    const person = await member(media, {
      email: 'cota@example.com',
      topics: ['hermetismo'],
      features: ['media', 'media-upload'],
    });
    const nearlyAll = await person.call(
      'POST',
      TOPIC_MEDIA,
      aRequest({ author: null, durationMs: 150 * HOUR_MS }),
    );
    expect(nearlyAll.statusCode).toBe(201);
    const sent = await patch(media, {
      id: nearlyAll.json().id,
      offset: 0,
      body: AUDIO,
      headers: person.headers,
    });
    expect(sent.statusCode).toBe(204);
    const big = aCheck({ durationMs: 150 * HOUR_MS, sha256: 'c'.repeat(64) });
    const before = await person.call('POST', `${TOPIC_MEDIA}/check`, big);
    expect(before.json().verdict).toBe('over-quota');
    await convert(media, await leaseJob(media));
    const after = await person.call('POST', `${TOPIC_MEDIA}/check`, big);
    expect(after.json().verdict).toBe('new');
  });
});
