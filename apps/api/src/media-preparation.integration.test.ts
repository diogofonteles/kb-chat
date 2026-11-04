import type {
  MediaItem,
  MediaPreparation,
  OpenPreparations,
  PreparationOptions,
  PreparationPlanRequest,
} from '@kb-chat/contracts';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import {
  caller,
  closeApp,
  connectHouse,
  signIn,
  type Call,
} from '../test/ai-app-harness.js';
import {
  conversationRaw,
  leaseDiarization,
  pairDiarizer,
  sendTurns,
} from '../test/diarization-harness.js';
import {
  AUDIO,
  aRequest,
  leaseJob,
  member,
  startMedia,
  upload,
  type Media,
} from '../test/media-harness.js';
import { windowIds } from '../test/track-proposal-fixtures.js';
import {
  asTranscriber,
  convertWithFlac,
  leaseTranscription,
  sendTranscript,
} from '../test/transcription-harness.js';
import {
  FAKE_FREE_MODELS,
  type FakeChatBody,
} from './testing/fake-openrouter.js';

afterEach(closeApp);

const MODEL = {
  id: 'deepseek/deepseek-v4-flash',
  pricing: { prompt: '0.000000091', completion: '0.000000182' },
};

const AI_PLAN: PreparationPlanRequest = {
  transcribe: true,
  speakers: true,
  tracks: 'ai',
  subjects: false,
  acceptedUsd: 0.05,
};
const FREE_PLAN: PreparationPlanRequest = {
  transcribe: true,
  speakers: true,
  tracks: 'none',
  subjects: false,
  acceptedUsd: null,
};

/** One track over the whole window the prompt names. */
const oneTrack = (titulo: string) => (body: FakeChatBody) => {
  const { first, last } = windowIds(
    String(body.messages?.at(-1)?.content ?? ''),
  );
  return {
    content: JSON.stringify({
      faixas: [
        {
          primeiro_id: first,
          ultimo_id: last,
          tipo: 'pergunta_resposta',
          quem_pergunta: null,
          quem_responde: null,
          titulo,
          continua_faixa_anterior: false,
        },
      ],
    }),
    cost: 0.0012,
  };
};

const preparation = (id: string) => `/api/v1/media/${id}/preparation`;

async function read(media: Media, id: string): Promise<MediaPreparation> {
  const answer = await media.owner('GET', preparation(id));
  expect(answer.statusCode, answer.body).toBe(200);
  return answer.json<MediaPreparation>();
}

const stage = (prep: MediaPreparation, id: string) =>
  prep.stages.find((one) => one.stage === id);

/** An owner with the house AI connected and a Mac that transcribes and separates. */
async function connected() {
  const media = await startMedia();
  const { token } = await pairDiarizer(media);
  media.started.fake.models = [...FAKE_FREE_MODELS, MODEL];
  await connectHouse(media.started, media.owner);
  return { media, token };
}

/** Sends a file with this plan and converts it. */
async function uploaded(
  media: Media,
  plan: PreparationPlanRequest,
  call: Call = media.owner,
): Promise<MediaItem> {
  const created = await call(
    'POST',
    '/api/v1/topics/hermetismo/media',
    aRequest({ author: null, plan }),
  );
  expect(created.statusCode, created.body).toBe(201);
  const item = created.json<MediaItem>();
  expect((await upload(media, { id: item.id, body: AUDIO })).statusCode).toBe(
    200,
  );
  expect((await convertWithFlac(media, await leaseJob(media))).statusCode).toBe(
    204,
  );
  return item;
}

async function transcribe(media: Media, token: string): Promise<void> {
  const job = await leaseTranscription(media, token);
  const sent = await sendTranscript(media, {
    token,
    job,
    raw: conversationRaw(),
  });
  expect(sent.statusCode).toBe(204);
}

async function separate(media: Media, token: string): Promise<void> {
  const job = await leaseDiarization(media, token);
  expect((await sendTurns(media, { token, job })).statusCode).toBe(204);
}

/** Up to the moment the paid stage is taken, on a read of the plan. */
async function upToProposal(
  media: Media,
  token: string,
  plan: PreparationPlanRequest,
): Promise<string> {
  const item = await uploaded(media, plan);
  await transcribe(media, token);
  await read(media, item.id); // Asks for the voices.
  await separate(media, token);
  return item.id;
}

async function settled(media: Media, id: string): Promise<MediaPreparation> {
  for (let tick = 0; tick < 200; tick++) {
    const now = await read(media, id);
    const state = stage(now, 'tracks')?.state;
    if (state === 'done' || state === 'failed') return now;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('the proposal never ended');
}

describe('choosing at upload (KBC-072 FR-1)', () => {
  it('refuses an option without its permission, with the reason, and creates nothing (AC-13)', async () => {
    const media = await startMedia();
    const { call } = await member(media, {
      email: 'editor@example.com',
      topics: ['hermetismo'],
      features: ['media', 'media-upload', 'media-edit'],
    });
    const refused = await call(
      'POST',
      '/api/v1/topics/hermetismo/media',
      aRequest({ author: null, plan: AI_PLAN }),
    );
    expect(refused.statusCode).toBe(422);
    expect(refused.json().error).toMatchObject({
      code: 'PLAN_REFUSED',
      details: { options: [{ option: 'ai', refusal: 'permission' }] },
    });
    const list = await call('GET', '/api/v1/topics/hermetismo/media');
    expect(list.json().items).toEqual([]);
  });

  it('refuses voices without the transcription they need (BR-1)', async () => {
    const media = await startMedia();
    const refused = await media.owner(
      'POST',
      '/api/v1/topics/hermetismo/media',
      aRequest({
        author: null,
        plan: { ...FREE_PLAN, transcribe: false },
      }),
    );
    expect(refused.statusCode).toBe(422);
    expect(refused.json().error.details.options).toEqual([
      { option: 'speakers', refusal: 'dependency' },
    ]);
  });

  it('refuses a paid option with no value agreed to (BR-4)', async () => {
    const { media } = await connected();
    const refused = await media.owner(
      'POST',
      '/api/v1/topics/hermetismo/media',
      aRequest({ author: null, plan: { ...AI_PLAN, acceptedUsd: null } }),
    );
    expect(refused.statusCode).toBe(422);
    expect(refused.json().error.details.options).toEqual([
      { option: 'ai', refusal: 'no-estimate' },
    ]);
  });

  it('refuses the AI with the house account not connected', async () => {
    const media = await startMedia();
    const refused = await media.owner(
      'POST',
      '/api/v1/topics/hermetismo/media',
      aRequest({ author: null, plan: AI_PLAN }),
    );
    expect(refused.json().error.details.options).toEqual([
      { option: 'ai', refusal: 'not-connected' },
    ]);
  });

  it('refuses subjects: nothing can run them yet (KBC-069)', async () => {
    const media = await startMedia();
    const refused = await media.owner(
      'POST',
      '/api/v1/topics/hermetismo/media',
      aRequest({ author: null, plan: { ...FREE_PLAN, subjects: true } }),
    );
    expect(refused.json().error.details.options).toEqual([
      { option: 'subjects', refusal: 'unavailable' },
    ]);
  });

  it('with only "Transcrever", keeps no plan: the upload is today\'s (AC-15)', async () => {
    const media = await startMedia();
    const item = await uploaded(media, {
      ...FREE_PLAN,
      speakers: false,
    });
    const prep = await read(media, item.id);
    expect(prep).toMatchObject({ step: 1, plan: null, stages: [] });
  });

  it('with "Transcrever" unticked, queues no transcription and keeps no FLAC', async () => {
    const media = await startMedia();
    const { token } = await pairDiarizer(media);
    const item = await uploaded(media, {
      ...FREE_PLAN,
      transcribe: false,
      speakers: false,
    });
    const lease = await asTranscriber(media, token, {
      method: 'POST',
      url: '/api/v1/media-worker/jobs/lease',
      payload: { worker: 'mac', kinds: ['transcribe'] },
    });
    expect(lease.statusCode).toBe(204);
    const open = await media.owner('GET', '/api/v1/media/preparations');
    expect(open.json<OpenPreparations>().items).toEqual([]);
    expect((await read(media, item.id)).finished).toBe(true);
  });
});

describe('the options (FR-7, BR-3)', () => {
  const options = (call: Call, query = 'durationMs=3720000') =>
    call('GET', `/api/v1/media/preparation-options?${query}`);

  it('says why the AI is off for who has no permission, and shows no money (AC-1)', async () => {
    const { media } = await connected();
    const { call } = await member(media, {
      email: 'editor@example.com',
      topics: ['hermetismo'],
      features: ['media', 'media-upload', 'media-edit'],
    });
    const body = (await options(call)).json<PreparationOptions>();
    expect(body.options.ai.refusal).toBe('permission');
    expect(body.options.speakers.refusal).toBeNull();
    expect(body.aiEstimateUsd).toBeNull();
    expect(body.monthRemainingUsd).toBeNull();
  });

  it('says why voices are off without "media-edit"', async () => {
    const media = await startMedia();
    const { call } = await member(media, {
      email: 'sender@example.com',
      topics: ['hermetismo'],
      features: ['media', 'media-upload'],
    });
    const body = (await options(call)).json<PreparationOptions>();
    expect(body.options.speakers.refusal).toBe('permission');
    expect(body.options.manual.refusal).toBe('permission');
    expect(body.options.subjects.refusal).toBe('unavailable');
  });

  it('gives the cost and the month by the length, with default times (AC-3, FR-7)', async () => {
    const { media } = await connected();
    const body = (await options(media.owner)).json<PreparationOptions>();
    expect(body.options.ai.refusal).toBeNull();
    expect(body.aiEstimateUsd).toBeGreaterThan(0);
    expect(body.monthRemainingUsd).toBeGreaterThan(0);
    expect(body.options.transcribe.minutes).toBe(4);
    expect(body.options.speakers.minutes).toBe(3);
  });

  it('has no estimate and no paid value without a length', async () => {
    const { media } = await connected();
    const body = (await options(media.owner, '')).json<PreparationOptions>();
    expect(body.aiEstimateUsd).toBeNull();
    expect(body.options.transcribe.minutes).toBeNull();
  });
});

describe('going through the stages (FR-2, BR-5)', () => {
  it('shows the cuts from the beat, and a heartbeat without them keeps working (AC-6, FR-3)', async () => {
    const { media, token } = await connected();
    const item = await uploaded(media, FREE_PLAN);
    const job = await leaseTranscription(media, token);
    const beat = (cuts?: object) =>
      asTranscriber(media, token, {
        method: 'POST',
        url: `/api/v1/media-worker/jobs/${job.id}/heartbeat`,
        payload: { worker: 'mac', leaseId: job.leaseId, progress: 0, cuts },
      });
    expect((await beat()).statusCode).toBe(204);
    expect(stage(await read(media, item.id), 'transcribe')).toMatchObject({
      state: 'running',
      percent: null,
      cuts: null,
    });
    expect((await beat({ done: 14, total: 40 })).statusCode).toBe(204);
    expect(stage(await read(media, item.id), 'transcribe')).toMatchObject({
      percent: 35,
      cuts: { done: 14, total: 40 },
    });
    expect((await beat({ done: 41, total: 40 })).statusCode).toBe(400);
  });

  it('asks for the voices once the words exist, and only once', async () => {
    const { media, token } = await connected();
    const item = await uploaded(media, FREE_PLAN);
    expect(stage(await read(media, item.id), 'speakers')?.state).toBe(
      'waiting',
    );
    await transcribe(media, token);
    expect(stage(await read(media, item.id), 'speakers')?.state).toBe('queued');
    await read(media, item.id);
    await separate(media, token);
    const done = await read(media, item.id);
    expect(stage(done, 'speakers')?.state).toBe('done');
    expect(done.voices.length).toBeGreaterThan(1);
    expect(done.next).toBe('conclude');
    expect(done.step).toBe(2);
  });

  it('does not move on by itself, and "Concluir" ends it at step 4 (AC-8, AC-9)', async () => {
    const { media, token } = await connected();
    const item = await uploaded(media, FREE_PLAN);
    await transcribe(media, token);
    await read(media, item.id);
    await separate(media, token);
    expect((await read(media, item.id)).step).toBe(2);
    const moved = await media.owner(
      'POST',
      `${preparation(item.id)}/advance`,
      {},
    );
    expect(moved.json<MediaPreparation>()).toMatchObject({
      step: 4,
      skipped: true,
      finished: true,
      next: null,
    });
  });

  it('refuses moving on while anything runs', async () => {
    const { media } = await connected();
    const item = await uploaded(media, FREE_PLAN);
    const moved = await media.owner(
      'POST',
      `${preparation(item.id)}/advance`,
      {},
    );
    expect(moved.statusCode).toBe(409);
  });

  it('goes to step 3 only by a press, and "Vou marcar eu mesmo" passes through it (AC-9)', async () => {
    const { media, token } = await connected();
    const item = await uploaded(media, {
      ...FREE_PLAN,
      speakers: false,
      tracks: 'manual',
    });
    await transcribe(media, token);
    const before = await read(media, item.id);
    expect(before).toMatchObject({ step: 2, next: 'validate', skipped: false });
    const moved = await media.owner(
      'POST',
      `${preparation(item.id)}/advance`,
      {},
    );
    expect(moved.json<MediaPreparation>().step).toBe(3);
  });

  it('tells the edit where the plan stands: the editor sends who comes early back (BR-5)', async () => {
    const { media, token } = await connected();
    const item = await uploaded(media, {
      ...FREE_PLAN,
      speakers: false,
      tracks: 'manual',
    });
    await transcribe(media, token);
    const edit = () => media.owner('GET', `/api/v1/media/${item.id}/edit`);
    expect((await edit()).json().preparationStep).toBe(2);
    await media.owner('POST', `${preparation(item.id)}/advance`, {});
    expect((await edit()).json().preparationStep).toBe(3);
  });

  it('lists where it stopped for the same person on another device (AC-10)', async () => {
    const { media, token } = await connected();
    const item = await uploaded(media, {
      ...FREE_PLAN,
      speakers: false,
      tracks: 'manual',
    });
    await transcribe(media, token);
    await media.owner('POST', `${preparation(item.id)}/advance`, {});
    const open = await media.owner('GET', '/api/v1/media/preparations');
    expect(open.json<OpenPreparations>().items).toEqual([
      { mediaId: item.id, step: 3 },
    ]);
  });

  it("hides another collection's plan from who cannot see it", async () => {
    const { media } = await connected();
    await uploaded(media, FREE_PLAN);
    const { call } = await member(media, {
      email: 'other@example.com',
      topics: [],
      features: ['media', 'media-edit'],
    });
    const open = await call('GET', '/api/v1/media/preparations');
    expect(open.json<OpenPreparations>().items).toEqual([]);
  });

  it('answers 403 to who cannot edit recordings', async () => {
    const media = await startMedia();
    const { call } = await member(media, {
      email: 'listener@example.com',
      topics: ['hermetismo'],
      features: ['media'],
    });
    const item = await uploaded(media, FREE_PLAN);
    expect((await call('GET', preparation(item.id))).statusCode).toBe(403);
  });
});

describe('money (BR-2, BR-4, KBC-066 BR-1)', () => {
  it('runs a chosen proposal once, windows growing, and applies nothing (AC-7)', async () => {
    const { media, token } = await connected();
    media.started.fake.scripted.push(oneTrack('Primeira pergunta'));
    const id = await upToProposal(media, token, AI_PLAN);
    const done = await settled(media, id);
    expect(stage(done, 'tracks')).toMatchObject({
      state: 'done',
      windows: { done: 1, total: 1 },
    });
    expect(stage(done, 'tracks')?.reservedUsd).toBeGreaterThan(0);
    expect(done.tracks).toEqual([
      expect.objectContaining({
        title: 'Primeira pergunta',
        status: 'proposed',
      }),
    ]);
    expect(done.next).toBe('validate');
    const calls = media.started.fake.chatBodies.length;
    await read(media, id);
    await read(media, id);
    expect(media.started.fake.chatBodies).toHaveLength(calls);
    const heard = await media.owner('GET', `/api/v1/media/${id}/tracks`);
    expect(heard.json().tracks).toEqual([]);
  });

  it('stops without spending when the real estimate is past what was seen', async () => {
    const { media, token } = await connected();
    const id = await upToProposal(media, token, {
      ...AI_PLAN,
      acceptedUsd: 0.000001,
    });
    const stopped = await settled(media, id);
    expect(stage(stopped, 'tracks')).toMatchObject({
      state: 'failed',
      failure: 'estimate-rose',
      canRetry: true,
    });
    expect(stage(stopped, 'tracks')?.estimateUsd).toBeGreaterThan(0.000001);
    expect(media.started.fake.chatBodies).toHaveLength(0);
  });

  it('pays the new value only on a click', async () => {
    const { media, token } = await connected();
    const id = await upToProposal(media, token, {
      ...AI_PLAN,
      acceptedUsd: 0.000001,
    });
    await settled(media, id);
    await read(media, id);
    expect(media.started.fake.chatBodies).toHaveLength(0);
    media.started.fake.scripted.push(oneTrack('Depois do clique'));
    const pressed = await media.owner(
      'POST',
      `${preparation(id)}/steps/tracks/retry`,
      {},
    );
    expect(pressed.statusCode).toBe(200);
    const done = await settled(media, id);
    expect(stage(done, 'tracks')?.state).toBe('done');
    expect(done.tracks[0]?.title).toBe('Depois do clique');
  });

  it('does not repeat a failed run by itself, and keeps the work before it (AC-11)', async () => {
    const { media, token } = await connected();
    media.started.fake.scripted.push({ status: 503 });
    const id = await upToProposal(media, token, AI_PLAN);
    const failed = await settled(media, id);
    expect(stage(failed, 'tracks')).toMatchObject({
      state: 'failed',
      failure: 'provider',
      canRetry: true,
    });
    expect(stage(failed, 'transcribe')?.state).toBe('done');
    expect(stage(failed, 'speakers')?.state).toBe('done');
    expect(failed.canSwitchToManual).toBe(true);
    const calls = media.started.fake.chatBodies.length;
    await read(media, id);
    await read(media, id);
    expect(media.started.fake.chatBodies).toHaveLength(calls);
  });

  it('"Marcar as faixas eu mesmo" leaves the AI and opens step 3 (AC-11)', async () => {
    const { media, token } = await connected();
    media.started.fake.scripted.push({ status: 503 });
    const id = await upToProposal(media, token, AI_PLAN);
    await settled(media, id);
    const switched = await media.owner('PATCH', preparation(id), {
      tracks: 'manual',
    });
    expect(switched.json<MediaPreparation>()).toMatchObject({
      next: 'validate',
      canSwitchToManual: false,
    });
    expect(stage(switched.json<MediaPreparation>(), 'tracks')).toBeUndefined();
    const moved = await media.owner('POST', `${preparation(id)}/advance`, {});
    expect(moved.json<MediaPreparation>().step).toBe(3);
  });

  it('runs nothing for who lost the permission since choosing', async () => {
    const { media, token } = await connected();
    const invited = await media.owner('POST', '/api/v1/people', {
      email: 'editor@example.com',
      sendEmail: false,
    });
    const grant = (features: string[]) =>
      media.owner('PATCH', `/api/v1/people/${invited.json().id}`, {
        topics: ['hermetismo'],
        features,
      });
    const every = ['media', 'media-upload', 'media-edit', 'media-edit-ai'];
    await grant(every);
    const headers = await signIn(media.started, 'editor@example.com');
    const call = caller(media.started.app, headers);
    const created = await call(
      'POST',
      '/api/v1/topics/hermetismo/media',
      aRequest({ author: null, plan: AI_PLAN }),
    );
    expect(created.statusCode, created.body).toBe(201);
    const { id } = created.json<MediaItem>();
    await upload(media, { id, body: AUDIO, headers });
    await convertWithFlac(media, await leaseJob(media));
    await transcribe(media, token);
    await read(media, id);
    await separate(media, token);
    await grant(['media', 'media-upload', 'media-edit']);
    const stopped = await settled(media, id);
    expect(stage(stopped, 'tracks')?.failure).toBe('no-permission');
    expect(media.started.fake.chatBodies).toHaveLength(0);
  });

  it('never retries a paid stage for who may not propose', async () => {
    const { media, token } = await connected();
    media.started.fake.scripted.push({ status: 503 });
    const id = await upToProposal(media, token, AI_PLAN);
    await settled(media, id);
    const { call } = await member(media, {
      email: 'editor@example.com',
      topics: ['hermetismo'],
      features: ['media', 'media-edit'],
    });
    const pressed = await call(
      'POST',
      `${preparation(id)}/steps/tracks/retry`,
      {},
    );
    expect(pressed.statusCode).toBe(409);
  });
});

describe('failures of free stages (BR-6, FR-4)', () => {
  it('"Tentar de novo" redoes the separation that failed', async () => {
    const { media, token } = await connected();
    const item = await uploaded(media, FREE_PLAN);
    await transcribe(media, token);
    await read(media, item.id);
    for (let attempt = 0; attempt < 4; attempt++) {
      const job = await leaseDiarization(media, token);
      await asTranscriber(media, token, {
        method: 'POST',
        url: `/api/v1/media-worker/jobs/${job.id}/fail`,
        payload: {
          worker: 'mac',
          leaseId: job.leaseId,
          failure: 'conversion-failed',
          detail: 'boom',
        },
      });
    }
    expect(stage(await read(media, item.id), 'speakers')).toMatchObject({
      state: 'failed',
      canRetry: true,
    });
    const pressed = await media.owner(
      'POST',
      `${preparation(item.id)}/steps/speakers/retry`,
      {},
    );
    expect(stage(pressed.json<MediaPreparation>(), 'speakers')?.state).toBe(
      'queued',
    );
  });

  it('refuses a retry of a stage that did not fail', async () => {
    const { media } = await connected();
    const item = await uploaded(media, FREE_PLAN);
    const pressed = await media.owner(
      'POST',
      `${preparation(item.id)}/steps/transcribe/retry`,
      {},
    );
    expect(pressed.statusCode).toBe(409);
  });

  it('refuses a stage that does not exist', async () => {
    const { media } = await connected();
    const item = await uploaded(media, FREE_PLAN);
    const pressed = await media.owner(
      'POST',
      `${preparation(item.id)}/steps/upload/retry`,
      {},
    );
    expect(pressed.statusCode).toBe(400);
  });
});

describe('an audio already sent (AC-16)', () => {
  it('asks only for what is missing', async () => {
    const { media, token } = await connected();
    const item = await uploaded(media, { ...FREE_PLAN, speakers: false });
    await transcribe(media, token);
    const started = await media.owner('POST', preparation(item.id), {
      plan: { ...FREE_PLAN, tracks: 'manual' },
    });
    expect(started.statusCode, started.body).toBe(200);
    const prep = started.json<MediaPreparation>();
    expect(prep.plan).toMatchObject({ transcribe: false, speakers: true });
    expect(prep.stages.map((one) => one.stage)).toEqual([
      'upload',
      'convert',
      'speakers',
    ]);
    const options = await media.owner(
      'GET',
      `/api/v1/media/preparation-options?mediaId=${item.id}`,
    );
    expect(options.json<PreparationOptions>().options.transcribe.done).toBe(
      true,
    );
  });

  it('asks for a transcription an upload left out', async () => {
    const { media, token } = await connected();
    const item = await uploaded(media, {
      ...FREE_PLAN,
      transcribe: false,
      speakers: false,
    });
    await media.owner('POST', preparation(item.id), {
      plan: { ...FREE_PLAN, speakers: false, tracks: 'manual' },
    });
    await transcribe(media, token);
    expect((await read(media, item.id)).next).toBe('validate');
  });

  it('refuses dividing tracks already approved, and ends a plan on approval', async () => {
    const { media, token } = await connected();
    const item = await uploaded(media, {
      ...FREE_PLAN,
      speakers: false,
      tracks: 'manual',
    });
    await transcribe(media, token);
    await media.owner('POST', `${preparation(item.id)}/advance`, {});
    const headers = { ...media.ownerHeaders, 'if-match': '"0"' };
    const saved = await media.started.app.inject({
      method: 'PUT',
      url: `/api/v1/media/${item.id}/edit`,
      headers,
      payload: {
        step: 3,
        tracks: [
          {
            id: randomUUID(),
            source: 'manual',
            startMs: 0,
            endMs: 30_000,
            kind: 'qa',
            title: 'Primeira',
            askerVoice: null,
            answererVoice: null,
            askerSpeakerId: null,
            answererSpeakerId: null,
          },
        ],
      },
    });
    expect(saved.statusCode, saved.body).toBe(200);
    const approved = await media.started.app.inject({
      method: 'POST',
      url: `/api/v1/media/${item.id}/edit/approve`,
      headers: { ...media.ownerHeaders, 'if-match': '"1"' },
      payload: {},
    });
    expect(approved.statusCode, approved.body).toBe(200);
    expect(await read(media, item.id)).toMatchObject({
      step: 4,
      finished: true,
    });
    const open = await media.owner('GET', '/api/v1/media/preparations');
    expect(open.json<OpenPreparations>().items).toEqual([]);
    const again = await media.owner('POST', preparation(item.id), {
      plan: { ...FREE_PLAN, speakers: false, tracks: 'manual' },
    });
    expect(again.statusCode).toBe(422);
    expect(again.json().error.details.options).toEqual([
      { option: 'manual', refusal: 'approved' },
    ]);
    const options = await media.owner(
      'GET',
      `/api/v1/media/preparation-options?mediaId=${item.id}`,
    );
    expect(options.json<PreparationOptions>().options.ai.refusal).toBe(
      'approved',
    );
  });

  it('refuses a second plan while one is open', async () => {
    const { media } = await connected();
    const item = await uploaded(media, FREE_PLAN);
    const second = await media.owner('POST', preparation(item.id), {
      plan: FREE_PLAN,
    });
    expect(second.statusCode).toBe(409);
  });

  it('refuses a recording not ready', async () => {
    const media = await startMedia();
    const created = await media.owner(
      'POST',
      '/api/v1/topics/hermetismo/media',
      aRequest({ author: null }),
    );
    const refused = await media.owner('POST', preparation(created.json().id), {
      plan: FREE_PLAN,
    });
    expect(refused.statusCode).toBe(409);
  });
});

describe('speed (NFR-2)', () => {
  it('answers in 150 ms with 200 tracks in the draft', async () => {
    const { media, token } = await connected();
    const item = await uploaded(media, {
      ...FREE_PLAN,
      speakers: false,
      tracks: 'manual',
    });
    await transcribe(media, token);
    const db = new DatabaseSync(join(media.mediaDir, 'media.db'));
    db.prepare('UPDATE media SET duration_ms = 7200000 WHERE id = ?').run(
      item.id,
    );
    db.close();
    const saved = await media.started.app.inject({
      method: 'PUT',
      url: `/api/v1/media/${item.id}/edit`,
      headers: { ...media.ownerHeaders, 'if-match': '"0"' },
      payload: {
        step: 3,
        tracks: Array.from({ length: 200 }, (_, index) => ({
          id: randomUUID(),
          source: 'manual',
          startMs: index * 30_000,
          endMs: (index + 1) * 30_000,
          kind: 'qa',
          title: `Faixa ${index + 1}`,
          askerVoice: null,
          answererVoice: null,
          askerSpeakerId: null,
          answererSpeakerId: null,
        })),
      },
    });
    expect(saved.statusCode, saved.body).toBe(200);
    const samples: number[] = [];
    for (let run = 0; run < 7; run++) {
      const from = performance.now();
      await read(media, item.id);
      samples.push(performance.now() - from);
    }
    expect((await read(media, item.id)).tracks).toHaveLength(200);
    expect(Math.min(...samples)).toBeLessThan(150);
  });
});
