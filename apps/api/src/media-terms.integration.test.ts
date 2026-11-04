import type {
  MediaItem,
  MediaTranscript,
  RawTranscript,
  TermList,
  TranscriptionTerms,
} from '@kb-chat/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { closeApp } from '../test/ai-app-harness.js';
import { member, startMedia, type Media } from '../test/media-harness.js';
import {
  asTranscriber,
  leaseTranscription,
  pair,
  readyForTranscription,
  sendTranscript,
  transcriptOf,
} from '../test/transcription-harness.js';
import { conversationRaw } from '../test/diarization-harness.js';

afterEach(closeApp);

const TERMS = '/api/v1/media/terms';

const listOf = async (media: Media): Promise<TermList> =>
  (await media.owner('GET', TERMS)).json();

const save = (media: Media, terms: string[], baseVersion: number) =>
  media.owner('PUT', TERMS, { baseVersion, terms });

const raw = (text: string): RawTranscript => conversationRaw([[0, 10, text]]);

const SILENT: RawTranscript = { chunks: [] };

/** An item with its first transcript, and the transcriber that made it. */
async function transcribed(media: Media, text = 'O Tioaco falou na sessão.') {
  const { token } = await pair(media);
  const item = await readyForTranscription(media);
  const job = await leaseTranscription(media, token);
  const sent = await sendTranscript(media, { token, job, raw: raw(text) });
  expect(sent.statusCode).toBe(204);
  return { item, token };
}

const itemOf = async (media: Media, id: string): Promise<MediaItem> =>
  (await media.owner('GET', `/api/v1/media/${id}`)).json();

const textOf = async (media: Media, id: string): Promise<string> => {
  const read = await media.owner('GET', `/api/v1/media/${id}/transcript`);
  const body = read.json<MediaTranscript>();
  return body.segments.map((one) => one.text).join(' ');
};

const subtitlesOf = async (media: Media, id: string): Promise<string> =>
  (await media.owner('GET', `/api/v1/media/${id}/subtitles.vtt`)).body;

const again = (media: Media, id: string) =>
  media.owner('POST', `/api/v1/media/${id}/transcription`);

const queuedTranscriptions = (media: Media, token: string) =>
  asTranscriber(media, token, {
    method: 'POST',
    url: '/api/v1/media-worker/jobs/lease',
    payload: { worker: 'mac', kinds: ['transcribe'] },
  });

describe('The term list (KBC-040 FR-1, FR-2, BR-1)', () => {
  it('starts with the pilot list, its use of the limit and no author', async () => {
    const media = await startMedia();
    const list = await listOf(media);
    expect(list).toMatchObject({
      version: 1,
      tokens: 162,
      limit: 224,
      authorName: null,
      createdAt: '2026-10-28T12:00:00.000Z',
    });
    expect(list.terms).toHaveLength(32);
    expect(list.versions).toHaveLength(1);
  });

  it('AC-1: a saved list is a new version, with date and author, for the next job', async () => {
    const media = await startMedia();
    const { token } = await pair(media);
    const { terms } = await listOf(media);
    const without = terms.map((one) => (one === 'Tiuaco' ? 'Tiwaco' : one));
    expect((await save(media, without, 1)).statusCode).toBe(200);

    const saved = await save(media, [...without, 'Tiuaco'], 2);

    expect(saved.statusCode).toBe(200);
    const body = saved.json<TermList>();
    expect(body.version).toBe(3);
    expect(body.authorName).toEqual(expect.any(String));
    expect(body.versions.map((one) => one.version)).toEqual([3, 2, 1]);
    const fetched = await asTranscriber(media, token, {
      method: 'GET',
      url: '/api/v1/media-worker/terms',
    });
    expect(fetched.json<TranscriptionTerms>()).toEqual({
      version: 3,
      terms: [...without, 'Tiuaco'],
    });
  });

  it('never transcribes anything because the list changed', async () => {
    const media = await startMedia();
    const { token } = await transcribed(media);
    const { terms } = await listOf(media);

    await save(media, [...terms, 'Novo Termo'], 1);

    expect((await queuedTranscriptions(media, token)).statusCode).toBe(204);
  });

  it('tidies the list and takes no version when nothing changed', async () => {
    const media = await startMedia();
    const { terms } = await listOf(media);
    const same = await save(
      media,
      [...terms, ` ${terms[0]?.toUpperCase()} `],
      1,
    );
    expect(same.statusCode).toBe(200);
    expect(same.json<TermList>().version).toBe(1);
  });

  it('AC-3: refuses a list past the limit and says by how much', async () => {
    const media = await startMedia();
    const { terms } = await listOf(media);
    const many = [
      ...terms,
      ...Array.from({ length: 30 }, (_, n) => `Termo ${n}`),
    ];

    const refused = await save(media, many, 1);

    expect(refused.statusCode).toBe(422);
    expect(refused.json().error).toMatchObject({
      code: 'TERMS_OVER_LIMIT',
      details: { limit: 224, tokens: expect.any(Number) },
    });
    expect(refused.json().error.details.tokens).toBeGreaterThan(224);
    expect((await listOf(media)).version).toBe(1);
  });

  it('measures a list without saving it', async () => {
    const media = await startMedia();
    const measured = await media.owner('POST', `${TERMS}/measure`, {
      terms: ['Tiuaco'],
    });
    expect(measured.json()).toEqual({ tokens: 4, limit: 224 });
    expect((await listOf(media)).version).toBe(1);
  });

  it('refuses an edit made on an older version: nobody overwrites anyone', async () => {
    const media = await startMedia();
    await save(media, ['Primeira'], 1);
    const late = await save(media, ['Segunda'], 1);
    expect(late.statusCode).toBe(409);
    expect(late.json().error.details).toEqual({
      reason: 'terms-changed',
      version: 2,
    });
    expect((await listOf(media)).terms).toEqual(['Primeira']);
  });

  it('refuses an empty list and a term the prompt cannot carry', async () => {
    const media = await startMedia();
    expect((await save(media, [], 1)).statusCode).toBe(400);
    expect((await save(media, ['a, b'], 1)).statusCode).toBe(400);
    expect((await save(media, ['<|endoftext|>'], 1)).statusCode).toBe(400);
  });

  it('AC-4: a member gets 403 on every term route and on transcribing again', async () => {
    const media = await startMedia();
    const { item } = await transcribed(media);
    const { call } = await member(media, {
      email: 'aluno@example.com',
      topics: [item.topic],
      features: ['media', 'media-upload', 'media-edit'],
    });
    expect((await call('GET', TERMS)).statusCode).toBe(403);
    const body = { baseVersion: 1, terms: ['Tiuaco'] };
    expect((await call('PUT', TERMS, body)).statusCode).toBe(403);
    expect(
      (await call('POST', `${TERMS}/measure`, { terms: ['a'] })).statusCode,
    ).toBe(403);
    expect(
      (await call('POST', `/api/v1/media/${item.id}/transcription`)).statusCode,
    ).toBe(403);
  });
});

describe('"Transcrever de novo" (KBC-040 FR-3, BR-3)', () => {
  it('AC-2: the old text stays until the new version is ready, which brings the new name', async () => {
    const media = await startMedia();
    const { item, token } = await transcribed(media);
    const before = await subtitlesOf(media, item.id);

    const queued = await again(media, item.id);

    expect(queued.statusCode).toBe(200);
    expect(queued.json<MediaItem>().transcription).toMatchObject({
      status: 'waiting',
      version: 1,
    });
    expect(queued.json<MediaItem>().canTranscribeAgain).toBe(false);
    const job = await leaseTranscription(media, token);
    expect((await itemOf(media, item.id)).transcription.status).toBe(
      'transcribing',
    );
    expect(await textOf(media, item.id)).toContain('Tioaco');
    expect(await subtitlesOf(media, item.id)).toBe(before);

    await sendTranscript(media, {
      token,
      job,
      raw: raw('O Tiuaco falou na sessão.'),
    });

    expect(await textOf(media, item.id)).toContain('Tiuaco');
    expect(await subtitlesOf(media, item.id)).toContain('Tiuaco');
    expect((await itemOf(media, item.id)).transcription).toMatchObject({
      status: 'done',
      version: 2,
    });
  });

  it('asks only once while one is pending', async () => {
    const media = await startMedia();
    const { item } = await transcribed(media);
    expect((await again(media, item.id)).statusCode).toBe(200);
    expect((await again(media, item.id)).statusCode).toBe(409);
  });

  it('a failed attempt keeps the text and says so, and the button comes back', async () => {
    const media = await startMedia();
    const { item, token } = await transcribed(media);
    await again(media, item.id);
    const job = await leaseTranscription(media, token);

    await asTranscriber(media, token, {
      method: 'POST',
      url: `/api/v1/media-worker/jobs/${job.id}/fail`,
      payload: {
        worker: 'mac',
        leaseId: job.leaseId,
        failure: 'invalid-audio',
        detail: 'no audio',
      },
    });

    const after = await itemOf(media, item.id);
    expect(after.transcription).toMatchObject({
      status: 'done',
      version: 1,
      lastAttemptFailed: true,
    });
    expect(after.canTranscribeAgain).toBe(true);
    expect(await textOf(media, item.id)).toContain('Tioaco');
  });

  it('an empty result never replaces a text: the attempt fails, the text stays', async () => {
    const media = await startMedia();
    const { item, token } = await transcribed(media);
    await again(media, item.id);
    const job = await leaseTranscription(media, token);

    const sent = await sendTranscript(media, { token, job, raw: SILENT });

    expect(sent.statusCode).toBe(204);
    expect((await itemOf(media, item.id)).transcription).toMatchObject({
      version: 1,
      lastAttemptFailed: true,
    });
    expect(await textOf(media, item.id)).toContain('Tioaco');
  });

  it('shows a member no way to ask for it', async () => {
    const media = await startMedia();
    const { item } = await transcribed(media);
    expect((await itemOf(media, item.id)).canTranscribeAgain).toBe(true);
    const { call } = await member(media, {
      email: 'ouve@example.com',
      topics: [item.topic],
      features: ['media'],
    });
    const seen = await call('GET', `/api/v1/media/${item.id}`);
    expect(seen.json<MediaItem>().canTranscribeAgain).toBe(false);
  });
});

describe('Which list a transcript was made with (KBC-040 FR-4)', () => {
  it('AC-5: a master sees it; whoever only listens does not', async () => {
    const media = await startMedia();
    const { item } = await transcribed(media);
    const read = await media.owner(
      'GET',
      `/api/v1/media/${item.id}/transcript`,
    );
    expect(read.json<MediaTranscript>().termList).toEqual({
      version: 1,
      createdAt: '2026-10-28T12:00:00.000Z',
    });
    const { call } = await member(media, {
      email: 'ouve@example.com',
      topics: [item.topic],
      features: ['media'],
    });
    const listener = await call('GET', `/api/v1/media/${item.id}/transcript`);
    expect(listener.json()).not.toHaveProperty('termList');
  });

  it('records the version the worker used, even when the list changed meanwhile', async () => {
    const media = await startMedia();
    const { token } = await pair(media);
    const item = await readyForTranscription(media);
    const job = await leaseTranscription(media, token);
    await save(media, ['Outra lista'], 1);

    await sendTranscript(media, {
      token,
      job,
      raw: raw('Uma frase qualquer.'),
    });

    const read = await media.owner(
      'GET',
      `/api/v1/media/${item.id}/transcript`,
    );
    expect(read.json<MediaTranscript>().termList?.version).toBe(1);
  });

  it('filters by the list the job used, not by the one saved during it', async () => {
    const media = await startMedia();
    const { token } = await pair(media);
    const item = await readyForTranscription(media);
    const job = await leaseTranscription(media, token);
    await save(media, ['Outra lista'], 1);

    await sendTranscript(media, {
      token,
      job,
      raw: conversationRaw([
        [0, 10, 'Frase de verdade dita aqui.'],
        [
          10,
          20,
          'Hoasca, Burracheira, Caiano, Minguarana, Lupunamanta, Supairunam, Perambulando, Mariri, Chacrona.',
        ],
      ]),
    });

    expect(await textOf(media, item.id)).not.toContain('Minguarana');
  });

  it('refuses a version that does not exist', async () => {
    const media = await startMedia();
    const { token } = await pair(media);
    await readyForTranscription(media);
    const job = await leaseTranscription(media, token);
    const sent = await asTranscriber(media, token, {
      method: 'POST',
      url: `/api/v1/media-worker/jobs/${job.id}/transcript`,
      payload: { ...transcriptOf(job), termsVersion: 99 },
    });
    expect(sent.statusCode).toBe(400);
  });
});
