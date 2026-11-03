import type {
  DraftTracks,
  MediaItem,
  ProposalEstimate,
  ProposalRun,
} from '@kb-chat/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { closeApp, connectHouse } from '../test/ai-app-harness.js';
import { member, startMedia, type Media } from '../test/media-harness.js';
import {
  leaseTranscription,
  pair,
  readyForTranscription,
  sendTranscript,
} from '../test/transcription-harness.js';
import { windowIds } from '../test/track-proposal-fixtures.js';
import {
  FAKE_FREE_MODELS,
  type FakeChatBody,
} from './testing/fake-openrouter.js';

afterEach(closeApp);

const HOUSE_KEY = 'sk-or-v1-house-oauth-wxyz';
const MODEL = {
  id: 'deepseek/deepseek-v4-flash',
  pricing: { prompt: '0.000000091', completion: '0.000000182' },
};

/** A transcribed recording, the house account connected and the media model listed. */
async function transcribed(): Promise<{ media: Media; item: MediaItem }> {
  const media = await startMedia();
  const { token } = await pair(media);
  const item = await readyForTranscription(media);
  const job = await leaseTranscription(media, token);
  expect((await sendTranscript(media, { token, job })).statusCode).toBe(204);
  media.started.fake.models = [...FAKE_FREE_MODELS, MODEL];
  await connectHouse(media.started, media.owner);
  return { media, item };
}

const proposals = (id: string) => `/api/v1/media/${id}/edit/proposals`;

/** One question-and-answer track over the whole window the prompt names. */
const oneTrack = (body: FakeChatBody) => {
  const user = String(body.messages?.at(-1)?.content ?? '');
  const { first, last } = windowIds(user);
  return {
    content: JSON.stringify({
      faixas: [
        {
          primeiro_id: first,
          ultimo_id: last,
          tipo: 'pergunta_resposta',
          quem_pergunta: null,
          quem_responde: null,
          titulo: 'Sobre a origem da UDV',
          continua_faixa_anterior: false,
        },
      ],
    }),
    cost: 0.0012,
  };
};

async function finished(media: Media, run: ProposalRun): Promise<ProposalRun> {
  for (let tick = 0; tick < 200; tick++) {
    const now = (
      await media.owner('GET', `${proposals(run.mediaId)}/${run.id}`)
    ).json<ProposalRun>();
    if (now.status !== 'running') return now;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error('the proposal never finished');
}

describe('Track proposals over HTTP (KBC-067)', () => {
  it('estimates, runs on the house account and writes the draft (AC-1, FR-1, FR-4)', async () => {
    const { media, item } = await transcribed();
    media.started.fake.scripted.push(oneTrack);
    const estimate = await media.owner('POST', proposals(item.id), {
      dryRun: true,
    });
    expect(estimate.statusCode).toBe(200);
    expect(estimate.json<ProposalEstimate>()).toMatchObject({
      model: MODEL.id,
      allowed: true,
      windows: 1,
      month: { spentUsd: 0, capUsd: 10 },
    });
    const started = await media.owner('POST', proposals(item.id), {});
    expect(started.statusCode).toBe(202);
    const run = await finished(media, started.json<ProposalRun>());
    expect(run).toMatchObject({ status: 'done', tracks: 1, spentUsd: 0.0012 });
    const draft = (
      await media.owner('GET', `/api/v1/media/${item.id}/edit/draft-tracks`)
    ).json<DraftTracks>();
    expect(draft.tracks).toEqual([
      expect.objectContaining({
        source: 'ai',
        kind: 'qa',
        title: 'Sobre a origem da UDV',
        firstSegment: 1,
      }),
    ]);
    const after = await media.owner('POST', proposals(item.id), {
      dryRun: true,
    });
    expect(after.json<ProposalEstimate>().month?.spentUsd).toBeCloseTo(0.0012);
  });

  it('sends only transcript text, JSON mode and no data retention, keys never logged (AC-10, BR-7)', async () => {
    const { media, item } = await transcribed();
    media.started.fake.scripted.push(oneTrack);
    const run = (await media.owner('POST', proposals(item.id), {})).json();
    await finished(media, run);
    const [body] = media.started.fake.chatBodies.slice(-1);
    expect(Object.keys(body ?? {}).sort()).toEqual([
      'max_tokens',
      'messages',
      'model',
      'provider',
      'reasoning',
      'response_format',
      'stream',
      'temperature',
      'usage',
    ]);
    expect(body).toMatchObject({
      model: MODEL.id,
      response_format: { type: 'json_object' },
      provider: { data_collection: 'deny' },
    });
    for (const message of body?.messages ?? [])
      expect(typeof message.content).toBe('string');
    expect(JSON.stringify(body)).not.toMatch(/fLaC|0123456789abcdefghij/);
    expect(media.started.logs.join('')).not.toContain(HOUSE_KEY);
  });

  it('ends a run the provider refuses as failed and keeps nothing of it (AC-6)', async () => {
    const { media, item } = await transcribed();
    media.started.fake.scripted.push({ status: 503 });
    const run = (await media.owner('POST', proposals(item.id), {})).json();
    expect(await finished(media, run)).toMatchObject({
      status: 'failed',
      failure: 'provider',
      spentUsd: 0,
    });
    const draft = (
      await media.owner('GET', `/api/v1/media/${item.id}/edit/draft-tracks`)
    ).json<DraftTracks>();
    expect(draft).toEqual({ run: null, tracks: [], voices: [] });
  });

  it('needs both features: editing alone or AI alone is 403 (AC-7, BR-2)', async () => {
    const { media, item } = await transcribed();
    const editor = await member(media, {
      email: 'editor@example.com',
      topics: ['hermetismo'],
      features: ['media', 'media-edit'],
    });
    const refused = await editor.call('POST', proposals(item.id), {
      dryRun: true,
    });
    expect(refused.statusCode).toBe(403);
    const draft = await editor.call(
      'GET',
      `/api/v1/media/${item.id}/edit/draft-tracks`,
    );
    expect(draft.statusCode).toBe(200);
    const aiOnly = await member(media, {
      email: 'ia@example.com',
      topics: ['hermetismo'],
      features: ['media', 'media-edit-ai'],
    });
    const alsoRefused = await aiOnly.call('POST', proposals(item.id), {
      dryRun: true,
    });
    expect(alsoRefused.statusCode).toBe(403);
    expect(media.started.fake.chatBodies).toHaveLength(0);
  });

  it('hides a recording of a collection the person cannot see (404)', async () => {
    const { media, item } = await transcribed();
    const outsider = await member(media, {
      email: 'fora@example.com',
      topics: [],
      features: ['media', 'media-edit', 'media-edit-ai'],
    });
    const refused = await outsider.call('POST', proposals(item.id), {
      dryRun: true,
    });
    expect(refused.statusCode).toBe(404);
    const run = await outsider.call(
      'GET',
      `${proposals(item.id)}/${crypto.randomUUID()}`,
    );
    expect(run.statusCode).toBe(404);
  });

  it('needs a transcript and the house account', async () => {
    const media = await startMedia();
    const item = await readyForTranscription(media);
    const early = await media.owner('POST', proposals(item.id), {
      dryRun: true,
    });
    expect(early.json().error.code).toBe('MEDIA_NOT_READY');
    const { token } = await pair(media);
    const job = await leaseTranscription(media, token);
    await sendTranscript(media, { token, job });
    const unconnected = await media.owner('POST', proposals(item.id), {
      dryRun: true,
    });
    expect(unconnected.statusCode).toBe(409);
    expect(unconnected.json().error.code).toBe('LLM_NOT_CONFIGURED');
  });
});
