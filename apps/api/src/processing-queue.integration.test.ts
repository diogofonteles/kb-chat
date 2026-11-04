import type {
  MediaItem,
  PreparationPlanRequest,
  ProcessingQueue,
} from '@kb-chat/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { closeApp } from '../test/ai-app-harness.js';
import { conversationRaw, pairDiarizer } from '../test/diarization-harness.js';
import {
  AUDIO,
  aRequest,
  leaseJob,
  member,
  startMedia,
  upload,
  type Media,
} from '../test/media-harness.js';
import {
  convertWithFlac,
  leaseTranscription,
  sendTranscript,
} from '../test/transcription-harness.js';

afterEach(closeApp);

const QUEUE = '/api/v1/media/processing';
const PLAN: PreparationPlanRequest = {
  transcribe: true,
  speakers: true,
  tracks: 'none',
  subjects: false,
  acceptedUsd: null,
};

async function sent(
  media: Media,
  plan: PreparationPlanRequest = PLAN,
  title = 'Gravação',
): Promise<MediaItem> {
  const created = await media.owner(
    'POST',
    '/api/v1/topics/hermetismo/media',
    aRequest({ author: null, title, plan }),
  );
  expect(created.statusCode, created.body).toBe(201);
  const item = created.json<MediaItem>();
  const uploaded = await upload(media, { id: item.id, body: AUDIO });
  expect(uploaded.statusCode).toBe(200);
  return item;
}

async function queueOf(media: Media): Promise<ProcessingQueue> {
  const answer = await media.owner('GET', QUEUE);
  expect(answer.statusCode, answer.body).toBe(200);
  return answer.json<ProcessingQueue>();
}

describe('GET /media/processing (KBC-090)', () => {
  it('is empty with nothing to process', async () => {
    const media = await startMedia();
    expect(await queueOf(media)).toMatchObject({ items: [], active: 0 });
  });

  it('says what waits, in the order the line takes them', async () => {
    const media = await startMedia();
    const first = await sent(media, PLAN, 'Primeira');
    const second = await sent(media, PLAN, 'Segunda');
    const queue = await queueOf(media);
    expect(queue.active).toBe(2);
    expect(queue.items.map((one) => one.mediaId)).toEqual([
      first.id,
      second.id,
    ]);
    expect(queue.items[1]).toMatchObject({
      title: 'Segunda',
      topic: 'hermetismo',
      phase: 'next',
      stage: 'convert',
      state: 'queued',
      position: 2,
      nextStage: 'transcribe',
      action: null,
    });
  });

  it('follows the stages: running, then what comes next', async () => {
    const media = await startMedia();
    const { token } = await pairDiarizer(media);
    const item = await sent(media);
    await convertWithFlac(media, await leaseJob(media));
    await leaseTranscription(media, token);
    const queue = await queueOf(media);
    expect(queue.items.map((one) => one.mediaId)).toEqual([item.id]);
    expect(queue.items[0]).toMatchObject({
      phase: 'running',
      stage: 'transcribe',
      state: 'running',
      nextStage: 'speakers',
      waitsForTranscriber: false,
    });
  });

  it('says the transcriber is off when that is why nothing moves', async () => {
    const media = await startMedia();
    await sent(media);
    await convertWithFlac(media, await leaseJob(media));
    const queue = await queueOf(media);
    expect(queue.transcriber).not.toBe('on');
    expect(queue.items[0]).toMatchObject({
      stage: 'transcribe',
      state: 'queued',
      position: 1,
      waitsForTranscriber: true,
    });
  });

  it('lists a plain transcription, which leaves no plan behind', async () => {
    const media = await startMedia();
    const item = await sent(media, {
      ...PLAN,
      speakers: false,
    });
    const queue = await queueOf(media);
    expect(queue.items.map((one) => one.mediaId)).toEqual([item.id]);
    expect(queue.items[0]?.step).toBeNull();
  });

  it('shows what ended to whoever must press next', async () => {
    const media = await startMedia();
    const { token } = await pairDiarizer(media);
    await sent(media, { ...PLAN, speakers: false, tracks: 'manual' });
    await convertWithFlac(media, await leaseJob(media));
    const job = await leaseTranscription(media, token);
    const done = await sendTranscript(media, {
      token,
      job,
      raw: conversationRaw(),
    });
    expect(done.statusCode, done.body).toBe(204);
    const queue = await queueOf(media);
    expect(queue.active).toBe(0);
    expect(queue.items[0]).toMatchObject({
      phase: 'attention',
      action: 'validate',
      step: 2,
    });
  });

  it('offers no action to who cannot edit recordings', async () => {
    const media = await startMedia();
    const { token } = await pairDiarizer(media);
    await sent(media, { ...PLAN, speakers: false, tracks: 'manual' });
    await convertWithFlac(media, await leaseJob(media));
    const job = await leaseTranscription(media, token);
    await sendTranscript(media, { token, job, raw: conversationRaw() });
    const { call } = await member(media, {
      email: 'envia@example.com',
      topics: ['hermetismo'],
      features: ['media', 'media-upload'],
    });
    const queue = (await call('GET', QUEUE)).json<ProcessingQueue>();
    expect(queue.items[0]).toMatchObject({ action: null });
  });

  it('never lists an upload still on its way', async () => {
    const media = await startMedia();
    await media.owner(
      'POST',
      '/api/v1/topics/hermetismo/media',
      aRequest({ author: null, plan: PLAN }),
    );
    expect((await queueOf(media)).items).toEqual([]);
  });

  it('needs "Enviar mídia", and hides what the person may not see', async () => {
    const media = await startMedia();
    await sent(media);
    const listener = await member(media, {
      email: 'ouve@example.com',
      topics: ['hermetismo'],
      features: ['media'],
    });
    expect((await listener.call('GET', QUEUE)).statusCode).toBe(403);
    const sameTopic = await member(media, {
      email: 'envia@example.com',
      topics: ['hermetismo'],
      features: ['media', 'media-upload'],
    });
    const answer = await sameTopic.call('GET', QUEUE);
    expect(answer.statusCode).toBe(200);
    // Not ready yet: only who sent it and masters follow it (KBC-051 BR-2).
    expect(answer.json<ProcessingQueue>()).toMatchObject({
      items: [],
      active: 0,
    });
  });

  it('leaves out another collection, ready or not', async () => {
    const media = await startMedia();
    await sent(media);
    await convertWithFlac(media, await leaseJob(media));
    const elsewhere = await member(media, {
      email: 'fora@example.com',
      topics: [],
      features: ['media', 'media-upload'],
    });
    const answer = await elsewhere.call('GET', QUEUE);
    expect(answer.json<ProcessingQueue>().items).toEqual([]);
  });

  it('refuses with no session', async () => {
    const media = await startMedia();
    const answer = await media.started.app.inject({
      method: 'GET',
      url: QUEUE,
    });
    expect(answer.statusCode).toBe(401);
  });
});
