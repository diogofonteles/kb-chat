import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type {
  GroqSettings,
  GroqTranscribeJob,
  MediaItem,
} from '@kb-chat/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { LOCAL, caller, closeApp, signIn } from '../test/ai-app-harness.js';
import {
  member,
  startMedia,
  worker,
  type Media,
} from '../test/media-harness.js';
import {
  asTranscriber,
  pair,
  readyForTranscription,
} from '../test/transcription-harness.js';

afterEach(closeApp);

// KBC-037 over HTTP: "Groq de reserva" for masters, "Transcrever com Groq", and the VM's
// chunks through the API that alone holds the key.

const VALID = 'gsk_live_secret_key_123_valid';
const INVALID = 'gsk_live_wrong_key_456';

const settingsOf = async (media: Media): Promise<GroqSettings> =>
  (await media.owner('GET', '/api/v1/media/groq')).json();

async function connected(media: Media, mode: 'manual' | 'idle' = 'manual') {
  const tested = await media.owner('POST', '/api/v1/media/groq/test', {
    key: VALID,
  });
  expect(tested.json()).toMatchObject({ ok: true });
  const saved = await media.owner('PUT', '/api/v1/media/groq/mode', {
    mode,
    idleHours: 12,
  });
  expect(saved.statusCode).toBe(200);
}

/** A second master, who is not the owner (BR-2). */
async function otherMaster(media: Media) {
  const invited = await media.owner('POST', '/api/v1/people', {
    email: 'bruno@example.com',
    sendEmail: false,
  });
  await media.owner('PATCH', `/api/v1/people/${invited.json().id}`, {
    role: 'master',
  });
  return caller(
    media.started.app,
    await signIn(media.started, 'bruno@example.com'),
  );
}

describe('"Groq de reserva": the connection (FR-1, BR-3)', () => {
  it('starts off, with no key, and shows the month and the cap (BR-1, FR-5)', async () => {
    const media = await startMedia();
    expect(await settingsOf(media)).toEqual({
      connected: false,
      keyProblem: null,
      mode: 'never',
      idleHours: 12,
      month: { spentUsd: 0, capUsd: 10 },
      canEditCap: true,
    });
  });

  it('refuses an invalid key with the reason, keeps nothing, and never echoes or logs it (AC-5)', async () => {
    const media = await startMedia();
    const tested = await media.owner('POST', '/api/v1/media/groq/test', {
      key: INVALID,
    });
    expect(tested.statusCode).toBe(200);
    expect(tested.json()).toEqual({ ok: false, reason: 'key-rejected' });
    expect(tested.body).not.toContain(INVALID);
    expect((await settingsOf(media)).connected).toBe(false);
    expect(media.started.logs.join('')).not.toContain(INVALID);
  });

  it('keeps a key Groq accepts, sealed, and never sends it back (BR-3)', async () => {
    const media = await startMedia();
    const tested = await media.owner('POST', '/api/v1/media/groq/test', {
      key: VALID,
    });
    expect(tested.json()).toMatchObject({
      ok: true,
      settings: { connected: true, mode: 'never' },
    });
    const again = await media.owner('POST', '/api/v1/media/groq/test', {});
    expect(again.json()).toMatchObject({ ok: true });
    expect(media.started.groq.keyChecks).toEqual([VALID, VALID]);
    for (const body of [
      tested.body,
      again.body,
      JSON.stringify(await settingsOf(media)),
    ])
      expect(body).not.toContain(VALID);
    const db = readFileSync(join(media.mediaDir, 'media.db'));
    expect(db.includes(Buffer.from(VALID))).toBe(false);
    expect(media.started.logs.join('')).not.toContain(VALID);
  });

  it('says there is no key to test, and removes the key', async () => {
    const media = await startMedia();
    const none = await media.owner('POST', '/api/v1/media/groq/test', {});
    expect(none.json()).toEqual({ ok: false, reason: 'no-key' });
    await connected(media);
    const removed = await media.owner('DELETE', '/api/v1/media/groq/key');
    expect(removed.json()).toMatchObject({ connected: false });
  });

  it('refuses every Groq route to a member, and refuses a bad mode', async () => {
    const media = await startMedia();
    const { call } = await member(media, {
      email: 'aluno@example.com',
      topics: ['hermetismo'],
      features: ['media', 'media-upload'],
    });
    expect((await call('GET', '/api/v1/media/groq')).statusCode).toBe(403);
    expect(
      (await call('POST', '/api/v1/media/groq/test', { key: VALID }))
        .statusCode,
    ).toBe(403);
    expect(
      (
        await call('PUT', '/api/v1/media/groq/mode', {
          mode: 'idle',
          idleHours: 1,
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (await call('PUT', '/api/v1/media/spend-cap', { capUsd: 50 })).statusCode,
    ).toBe(403);
    expect(media.started.groq.keyChecks).toEqual([]);
    const bad = await media.owner('PUT', '/api/v1/media/groq/mode', {
      mode: 'idle',
      idleHours: 0,
    });
    expect(bad.statusCode).toBe(400);
  });
});

describe('The monthly cap is the owner’s (BR-2)', () => {
  it('lets the owner change it, and another master only see it', async () => {
    const media = await startMedia();
    const changed = await media.owner('PUT', '/api/v1/media/spend-cap', {
      capUsd: 25,
    });
    expect(changed.json()).toMatchObject({ month: { capUsd: 25 } });
    const master = await otherMaster(media);
    const seen = await master('GET', '/api/v1/media/groq');
    expect(seen.json()).toMatchObject({
      month: { capUsd: 25 },
      canEditCap: false,
    });
    const refused = await master('PUT', '/api/v1/media/spend-cap', {
      capUsd: 1_000,
    });
    expect(refused.statusCode).toBe(403);
    expect((await settingsOf(media)).month.capUsd).toBe(25);
  });
});

describe('"Transcrever com Groq" on one item', () => {
  it('is refused while Groq is off, and not offered (BR-1)', async () => {
    const media = await startMedia();
    const item = await readyForTranscription(media);
    const got = await media.owner('GET', `/api/v1/media/${item.id}`);
    expect(got.json<MediaItem>().canUseGroq).toBe(false);
    const sent = await media.owner(
      'POST',
      `/api/v1/media/${item.id}/transcription/groq`,
    );
    expect(sent.statusCode).toBe(409);
    expect(sent.json().error.code).toBe('GROQ_UNAVAILABLE');
  });

  it('routes the waiting transcription to Groq; the VM transcribes it through the API (AC-2, AC-6)', async () => {
    const media = await startMedia();
    const { token } = await pair(media);
    const item = await readyForTranscription(media);
    await connected(media);
    const offered = await media.owner('GET', `/api/v1/media/${item.id}`);
    expect(offered.json<MediaItem>().canUseGroq).toBe(true);

    const sent = await media.owner(
      'POST',
      `/api/v1/media/${item.id}/transcription/groq`,
    );
    expect(sent.statusCode).toBe(200);
    expect(sent.json<MediaItem>()).toMatchObject({
      canUseGroq: false,
      transcription: { status: 'waiting', route: 'groq' },
    });
    // The Mac no longer gets it; the VM does.
    const mac = await asTranscriber(media, token, {
      method: 'POST',
      url: '/api/v1/media-worker/jobs/lease',
      payload: { worker: 'mac', kinds: ['transcribe'] },
    });
    expect(mac.statusCode).toBe(204);
    const leased = await worker(media, '/api/v1/media-worker/jobs/lease', {
      worker: 'vm',
      kinds: ['transcribe'],
    });
    expect(leased.statusCode).toBe(200);
    const job = leased.json<GroqTranscribeJob>();
    expect(job).toMatchObject({
      kind: 'transcribe',
      provider: 'groq',
      mediaId: item.id,
      sourcePath: `audio/${item.id}.flac`,
    });

    const chunk = await sendChunk(media, job, { startMs: 0, endMs: 20_000 });
    expect(chunk.statusCode).toBe(200);
    expect(chunk.json().result.segments[0].words[2].word).toBe('Hoasca');
    expect(media.started.groq.calls[0]?.prompt).toContain('Hoasca');

    const done = await worker(
      media,
      `/api/v1/media-worker/jobs/${job.id}/groq/transcript`,
      {
        worker: 'vm',
        leaseId: job.leaseId,
        termsVersion: job.termsVersion,
        vad: 'applied',
        speechRatio: 0.9,
        elapsedMs: 1_200,
        raw: { chunks: [{ offset: 0, end: 20, result: chunk.json().result }] },
      },
    );
    expect(done.statusCode, done.body).toBe(204);
    const after = await media.owner('GET', `/api/v1/media/${item.id}`);
    expect(after.json<MediaItem>().transcription).toMatchObject({
      status: 'done',
      provider: 'groq',
    });
    const groq = await settingsOf(media);
    expect(groq.month.spentUsd).toBeCloseTo((20 / 3_600) * 0.04, 8);
    expect(media.started.logs.join('')).not.toContain(VALID);
  });

  it('keeps a paired transcriber off the Groq routes, and refuses a chunk over 28 s', async () => {
    const media = await startMedia();
    const { token } = await pair(media);
    const item = await readyForTranscription(media);
    await connected(media);
    await media.owner('POST', `/api/v1/media/${item.id}/transcription/groq`);
    const job = (
      await worker(media, '/api/v1/media-worker/jobs/lease', {
        worker: 'vm',
        kinds: ['transcribe'],
      })
    ).json<GroqTranscribeJob>();
    const posing = await media.started.app.inject({
      method: 'POST',
      url: chunkUrl(job, { startMs: 0, endMs: 1_000 }),
      headers: {
        ...LOCAL,
        authorization: `Bearer ${token}`,
        'content-type': 'audio/flac',
      },
      payload: Buffer.from('fLaC'),
    });
    expect(posing.statusCode).toBe(404);
    const long = await sendChunk(media, job, { startMs: 0, endMs: 40_000 });
    expect(long.statusCode).toBe(400);
    expect(media.started.groq.calls).toEqual([]);
  });
});

const chunkUrl = (
  job: GroqTranscribeJob,
  span: { startMs: number; endMs: number },
) =>
  `/api/v1/media-worker/jobs/${job.id}/groq/chunks?${new URLSearchParams({
    worker: 'vm',
    leaseId: job.leaseId,
    startMs: String(span.startMs),
    endMs: String(span.endMs),
    termsVersion: String(job.termsVersion),
  }).toString()}`;

/** The VM sends one chunk of FLAC (fake bytes: the fake Groq does not decode them). */
const sendChunk = (
  media: Media,
  job: GroqTranscribeJob,
  span: { startMs: number; endMs: number },
) =>
  media.started.app.inject({
    method: 'POST',
    url: chunkUrl(job, span),
    headers: {
      ...LOCAL,
      authorization: `Bearer test-media-worker-token-0123456789abcdef`,
      'content-type': 'audio/flac',
    },
    payload: Buffer.from('fLaC chunk bytes'),
  });

describe('Who may reach the Groq routes (PD-06, PD-07)', () => {
  it('answers 401 to a request with no session, and leaves everything as it was', async () => {
    const media = await startMedia();
    const item = await readyForTranscription(media);
    await connected(media);
    const anonymous = caller(media.started.app, LOCAL);
    const calls: [string, string, object?][] = [
      ['GET', '/api/v1/media/groq'],
      ['POST', '/api/v1/media/groq/test', { key: VALID }],
      ['DELETE', '/api/v1/media/groq/key'],
      ['PUT', '/api/v1/media/groq/mode', { mode: 'never', idleHours: 1 }],
      ['PUT', '/api/v1/media/spend-cap', { capUsd: 0 }],
      ['POST', `/api/v1/media/${item.id}/transcription/groq`],
    ];
    for (const [method, url, payload] of calls)
      expect(
        (await anonymous(method as 'GET', url, payload)).statusCode,
        url,
      ).toBe(401);
    expect(await settingsOf(media)).toMatchObject({
      connected: true,
      mode: 'manual',
    });
    expect(media.started.groq.keyChecks).toEqual([VALID]);
  });

  it('answers 401 to the VM’s chunk and transcript routes without the worker token', async () => {
    const media = await startMedia();
    const item = await readyForTranscription(media);
    await connected(media);
    await media.owner('POST', `/api/v1/media/${item.id}/transcription/groq`);
    const job = (
      await worker(media, '/api/v1/media-worker/jobs/lease', {
        worker: 'vm',
        kinds: ['transcribe'],
      })
    ).json<GroqTranscribeJob>();
    for (const authorization of [
      undefined,
      'Bearer not-the-worker-token-0123456789',
    ]) {
      const headers = { ...LOCAL, ...(authorization && { authorization }) };
      const chunk = await media.started.app.inject({
        method: 'POST',
        url: chunkUrl(job, { startMs: 0, endMs: 1_000 }),
        headers: { ...headers, 'content-type': 'audio/flac' },
        payload: Buffer.from('fLaC'),
      });
      expect(chunk.statusCode).toBe(401);
      const transcript = await media.started.app.inject({
        method: 'POST',
        url: `/api/v1/media-worker/jobs/${job.id}/groq/transcript`,
        headers,
        payload: {
          worker: 'vm',
          leaseId: job.leaseId,
          termsVersion: 1,
          vad: 'applied',
          speechRatio: 1,
          elapsedMs: 1,
          raw: { chunks: [] },
        },
      });
      expect(transcript.statusCode).toBe(401);
    }
    expect(media.started.groq.calls).toEqual([]);
  });

  it('refuses "Transcrever com Groq" to a member (403) and to a master acting as someone (403)', async () => {
    const media = await startMedia();
    const item = await readyForTranscription(media);
    await connected(media);
    const { call } = await member(media, {
      email: 'aluno@example.com',
      topics: ['hermetismo'],
      features: ['media', 'media-upload'],
    });
    const url = `/api/v1/media/${item.id}/transcription/groq`;
    expect((await call('POST', url)).statusCode).toBe(403);

    const people = (await media.owner('GET', '/api/v1/people')).json();
    const aluno = people.items.find(
      (one: { email: string }) => one.email === 'aluno@example.com',
    );
    const acting = await media.owner(
      'POST',
      `/api/v1/people/${aluno.id}/act-as`,
      {
        reason: 'ver como o aluno vê',
      },
    );
    expect(acting.statusCode).toBe(200);
    const whileActing = await media.owner('POST', url);
    expect(whileActing.statusCode).toBe(403);
    expect(whileActing.json().error.code).toBe('NOT_WHILE_ACTING');
    await media.owner('DELETE', '/api/v1/act-as');

    const got = await media.owner('GET', `/api/v1/media/${item.id}`);
    expect(got.json<MediaItem>().transcription).toMatchObject({
      route: 'transcriber',
    });
  });

  it('answers 404 for an item the master cannot see, as for one that does not exist', async () => {
    const media = await startMedia();
    await connected(media);
    const sent = await media.owner(
      'POST',
      `/api/v1/media/${crypto.randomUUID()}/transcription/groq`,
    );
    expect(sent.statusCode).toBe(404);
  });

  it('refuses an empty or non-FLAC chunk (415) and an unknown term list version (400), calling Groq for none', async () => {
    const media = await startMedia();
    const item = await readyForTranscription(media);
    await connected(media);
    await media.owner('POST', `/api/v1/media/${item.id}/transcription/groq`);
    const job = (
      await worker(media, '/api/v1/media-worker/jobs/lease', {
        worker: 'vm',
        kinds: ['transcribe'],
      })
    ).json<GroqTranscribeJob>();
    for (const [type, payload] of [
      ['audio/flac', Buffer.alloc(0)],
      ['application/json', JSON.stringify({ audio: 'x' })],
    ] as const) {
      const refused = await media.started.app.inject({
        method: 'POST',
        url: chunkUrl(job, { startMs: 0, endMs: 1_000 }),
        headers: {
          ...LOCAL,
          authorization: `Bearer test-media-worker-token-0123456789abcdef`,
          'content-type': type,
        },
        payload,
      });
      expect(refused.statusCode, type).toBe(415);
    }
    const unknown = await sendChunk(
      media,
      { ...job, termsVersion: 999 },
      { startMs: 0, endMs: 1_000 },
    );
    expect(unknown.statusCode).toBe(400);
    expect(unknown.json().error.details).toMatchObject({
      field: 'termsVersion',
    });
    expect(media.started.groq.calls).toEqual([]);
  });
});
