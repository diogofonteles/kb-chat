/**
 * The media library under test (KBC-034, KBC-041): the app with media on, the owner signed
 * in, members with chosen grants, and a fake worker that "converts" an upload.
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { MediaItem, WorkerJob } from '@kb-chat/contracts';
import { expect } from 'vitest';
import {
  LOCAL,
  MEDIA_WORKER_TOKEN,
  caller,
  signIn,
  start,
  type Call,
  type Started,
} from './ai-app-harness.js';

export const WORKER = {
  ...LOCAL,
  authorization: `Bearer ${MEDIA_WORKER_TOKEN}`,
};
export const AUDIO = Buffer.from('ID3 fake mp3 bytes for the upload test');
export const CONVERTED = Buffer.from('0123456789abcdefghij'); // 20 bytes of "AAC"

export const aRequest = (overrides: object = {}) => ({
  title: 'Palestra de 1998',
  author: 'mestre-laercio',
  fileName: 'palestra.mp3',
  bytes: AUDIO.length,
  ...overrides,
});

export interface Media {
  readonly started: Started;
  readonly owner: Call;
  readonly ownerHeaders: Record<string, string>;
  readonly mediaDir: string;
}

export async function startMedia(
  options: { readonly vault?: string } = {},
): Promise<Media> {
  const started = await start({ media: true, ...options });
  const ownerHeaders = await signIn(started, 'owner@example.com');
  return {
    started,
    owner: caller(started.app, ownerHeaders),
    ownerHeaders,
    mediaDir: join(started.state, 'media'),
  };
}

/** A member who sees `topics` with `features`. */
export async function member(
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

export const upload = (
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
export async function queuedItem(
  media: Media,
  topic = 'hermetismo',
): Promise<MediaItem> {
  const created = await media.owner(
    'POST',
    `/api/v1/topics/${topic}/media`,
    aRequest(topic === 'hermetismo' ? {} : { author: null }),
  );
  expect(created.statusCode).toBe(201);
  const sent = await upload(media, { id: created.json().id, body: AUDIO });
  expect(sent.statusCode).toBe(200);
  return sent.json();
}

export const worker = (media: Media, url: string, payload: object) =>
  media.started.app.inject({ method: 'POST', url, headers: WORKER, payload });

export async function leaseJob(media: Media): Promise<WorkerJob> {
  const leased = await worker(media, '/api/v1/media-worker/jobs/lease', {
    worker: 'vm',
    kinds: ['transcode'],
  });
  expect(leased.statusCode).toBe(200);
  return leased.json();
}

/** Plays the worker: writes the "converted" file and completes the job. */
export async function convert(media: Media, job: WorkerJob) {
  writeFileSync(join(media.mediaDir, job.targetPath), CONVERTED);
  return worker(media, `/api/v1/media-worker/jobs/${job.id}/complete`, {
    worker: 'vm',
    leaseId: job.leaseId,
    durationMs: 180_000,
    bytes: CONVERTED.length,
  });
}

export async function readyItem(media: Media): Promise<MediaItem> {
  const item = await queuedItem(media);
  const done = await convert(media, await leaseJob(media));
  expect(done.statusCode).toBe(204);
  return { ...item, status: 'ready' };
}
