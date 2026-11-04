import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { closeApp } from '../test/ai-app-harness.js';
import {
  CONVERSATION,
  CONVERSATION_TURNS,
  conversationRaw,
  lease,
  leaseDiarization,
  pairDiarizer,
  requestVoices,
  sendTurns,
  speakersOf,
  transcribedItem,
  turnsOf,
} from '../test/diarization-harness.js';
import { member, startMedia, type Media } from '../test/media-harness.js';
import {
  asTranscriber,
  pair,
  readyForTranscription,
  sendTranscript,
} from '../test/transcription-harness.js';

afterEach(closeApp);

/** An item transcribed by a transcriber that also separates voices. */
async function ready(media: Media) {
  const { token, transcriber } = await pairDiarizer(media);
  const mediaId = await transcribedItem(media, token);
  return { token, transcriber, mediaId };
}

/** Asks, leases and answers a separation with `turns`; the item's speakers after it. */
async function separate(
  media: Media,
  input: {
    token: string;
    mediaId: string;
    voices?: number | null;
    turns?: typeof CONVERSATION_TURNS;
  },
) {
  const asked = await requestVoices(media, input.mediaId, {
    voices: input.voices ?? null,
  });
  expect(asked.statusCode).toBe(202);
  const job = await leaseDiarization(media, input.token);
  const sent = await sendTurns(media, {
    token: input.token,
    job,
    body: turnsOf(job, input.turns),
  });
  expect(sent.statusCode).toBe(204);
  return { job, speakers: await speakersOf(media, input.mediaId) };
}

describe('Separating voices (KBC-064 AC-1, FR-1 to FR-4)', () => {
  it('goes from waiting to diarizing to "3 voices", with the voice of every segment', async () => {
    const media = await startMedia();
    const { token, mediaId } = await ready(media);
    expect(await speakersOf(media, mediaId)).toMatchObject({
      status: 'none',
      transcriber: 'on',
      canRequest: true,
      diarization: null,
    });

    const asked = await requestVoices(media, mediaId);
    expect(asked.statusCode).toBe(202);
    expect(asked.json()).toMatchObject({
      status: 'waiting',
      canRequest: false,
    });
    const job = await leaseDiarization(media, token);
    expect(job).toMatchObject({
      mediaId,
      voices: null,
      durationMs: 180_000,
      audioPath: `/api/v1/media-worker/jobs/${job.id}/audio`,
    });
    expect((await speakersOf(media, mediaId)).status).toBe('diarizing');
    expect((await sendTurns(media, { token, job })).statusCode).toBe(204);

    const speakers = await speakersOf(media, mediaId);
    expect(speakers).toMatchObject({ status: 'done', canRequest: true });
    expect(speakers.diarization).toMatchObject({
      version: 1,
      transcriptVersion: 1,
      staleTranscript: false,
      requestedVoices: null,
      voiceCount: 3,
      voices: [
        { voice: 1, speakingMs: 12_100 },
        { voice: 2, speakingMs: 42_900 },
        { voice: 3, speakingMs: 5_000 },
      ],
    });
    // Voz 1 speaks first (the interviewer), Voz 3 is the question from the audience.
    expect(speakers.diarization?.segments.map((one) => one.voice)).toEqual([
      1, 2, 1, 2, 3, 2,
    ]);
    expect(speakers.diarization?.turns[0]).toEqual({
      voice: 1,
      startMs: 0,
      endMs: 5_200,
    });
  });

  it('keeps the raw result beside the transcripts and the voice of every word in the database', async () => {
    const media = await startMedia();
    const { token, mediaId } = await ready(media);
    await separate(media, { token, mediaId });
    const folder = join(media.mediaDir, 'transcripts', mediaId);
    const [rawFile] = readdirSync(folder).filter((name) =>
      name.startsWith('diarization-'),
    );
    const raw = JSON.parse(readFileSync(join(folder, rawFile ?? ''), 'utf8'));
    expect(raw).toMatchObject({
      engine: 'senko',
      parametersVersion: '2026-11-03.1',
      raw: { turns: CONVERSATION_TURNS },
    });
    expect(raw).not.toHaveProperty('leaseId');
    const db = new DatabaseSync(join(media.mediaDir, 'media.db'));
    const voices = db
      .prepare('SELECT voice FROM media_word_voices ORDER BY word_position')
      .all()
      .map((row) => row['voice']);
    db.close();
    const wordsPerSegment = CONVERSATION.map(
      ([, , text]) => text.split(' ').length,
    );
    expect(voices).toHaveLength(wordsPerSegment.reduce((a, b) => a + b, 0));
    expect(voices.slice(0, wordsPerSegment[0])).toEqual(
      Array(wordsPerSegment[0]).fill(1),
    );
    expect(voices.at(-1)).toBe(2);
  });

  it('refuses a second request while one waits, and a request with no transcript', async () => {
    const media = await startMedia();
    const { token, mediaId } = await ready(media);
    expect((await requestVoices(media, mediaId)).statusCode).toBe(202);
    const again = await requestVoices(media, mediaId);
    expect(again.statusCode).toBe(409);
    expect(again.json().error.code).toBe('MEDIA_CONFLICT');
    // An item converted but not transcribed yet has nothing to separate voices on.
    await leaseDiarization(media, token);
    const untranscribed = await readyForTranscription(media);
    const early = await requestVoices(media, untranscribed.id);
    expect(early.statusCode).toBe(409);
    expect(early.json().error.code).toBe('MEDIA_NOT_READY');
  });

  it('refuses an unknown item as 404 and a number of voices out of 1–10 as 400', async () => {
    const media = await startMedia();
    const { mediaId } = await ready(media);
    const unknown = await requestVoices(
      media,
      '99999999-9999-4999-8999-999999999999',
    );
    expect(unknown.statusCode).toBe(404);
    expect(
      (await requestVoices(media, mediaId, { voices: 11 })).statusCode,
    ).toBe(400);
    expect(
      (await requestVoices(media, mediaId, { voices: 0 })).statusCode,
    ).toBe(400);
  });
});

describe('Who may separate voices (KBC-064 AC-2, BR-2)', () => {
  it('refuses a person with only `media`: no request, no voices', async () => {
    const media = await startMedia();
    const { mediaId } = await ready(media);
    const { call } = await member(media, {
      email: 'ouvinte@example.com',
      topics: ['hermetismo'],
      features: ['media'],
    });
    expect((await call('GET', `/api/v1/media/${mediaId}`)).statusCode).toBe(
      200,
    );
    expect(
      (await call('POST', `/api/v1/media/${mediaId}/diarize`, {})).statusCode,
    ).toBe(403);
    expect(
      (await call('GET', `/api/v1/media/${mediaId}/speakers`)).statusCode,
    ).toBe(403);
  });

  it('lets a person with `media-edit` separate the voices of a collection they see', async () => {
    const media = await startMedia();
    const { mediaId } = await ready(media);
    const { call } = await member(media, {
      email: 'editor@example.com',
      topics: ['hermetismo'],
      features: ['media', 'media-edit'],
    });
    const asked = await call('POST', `/api/v1/media/${mediaId}/diarize`, {
      voices: 2,
    });
    expect(asked.statusCode).toBe(202);
    expect(asked.json().status).toBe('waiting');
  });

  it('hides an item of a collection the editor does not see (404)', async () => {
    const media = await startMedia();
    const { mediaId } = await ready(media);
    const { call } = await member(media, {
      email: 'outro@example.com',
      topics: [],
      features: ['media', 'media-edit'],
    });
    expect(
      (await call('GET', `/api/v1/media/${mediaId}/speakers`)).statusCode,
    ).toBe(404);
  });
});

describe('No voice print reaches the API (KBC-064 AC-3, BR-1, NFR-3)', () => {
  it('refuses a result that carries an embedding, whole', async () => {
    const media = await startMedia();
    const { token, mediaId } = await ready(media);
    await requestVoices(media, mediaId);
    const job = await leaseDiarization(media, token);
    const withPrint = turnsOf(job);
    const turn = { ...CONVERSATION_TURNS[0], embedding: [0.1, 0.2, 0.3] };
    const refused = await sendTurns(media, {
      token,
      job,
      body: { ...withPrint, raw: { turns: [turn] } },
    });
    expect(refused.statusCode).toBe(400);
    const centroids = await sendTurns(media, {
      token,
      job,
      body: {
        ...withPrint,
        raw: { ...withPrint.raw, centroids: { SPEAKER_01: [0.1] } },
      },
    });
    expect(centroids.statusCode).toBe(400);
    expect((await speakersOf(media, mediaId)).diarization).toBeNull();
  });

  it('keeps no table or column for a voice print in the media database', async () => {
    const media = await startMedia();
    const { token, mediaId } = await ready(media);
    await separate(media, { token, mediaId });
    const db = new DatabaseSync(join(media.mediaDir, 'media.db'));
    const columns = db
      .prepare(
        `SELECT m.name AS tbl, p.name AS col, p.type AS type
         FROM sqlite_master m JOIN pragma_table_info(m.name) p
         WHERE m.type = 'table'`,
      )
      .all();
    db.close();
    expect(
      columns.filter((row) =>
        /embed|centroid|print|vector/i.test(`${row['tbl']} ${row['col']}`),
      ),
    ).toEqual([]);
    // The only binary columns are SQLite's own for the text search index (KBC-039).
    expect(
      columns
        .filter((row) => row['type'] === 'BLOB')
        .map((row) => `${row['tbl']}.${row['col']}`),
    ).toEqual(['segments_fts_data.block', 'segments_fts_docsize.sz']);
  });
});

describe('A new transcript after the separation (KBC-064 AC-4, BR-3)', () => {
  it('keeps the voices, placed on the new segments, flagged as made on an older transcript', async () => {
    const media = await startMedia();
    const { token, mediaId } = await ready(media);
    await separate(media, { token, mediaId });
    const again = await media.owner(
      'POST',
      `/api/v1/media/${mediaId}/transcription`,
    );
    expect(again.statusCode).toBe(200);
    // A separation waits while its item is being transcribed again (BR-5).
    expect((await requestVoices(media, mediaId)).statusCode).toBe(202);
    const job = await lease(media, token);
    expect(job.json().kind).toBe('transcribe');
    const twoSegments = conversationRaw([
      [0, 15, 'Mestre, o senhor está lembrado? Eu lembro sim.'],
      [40.5, 45, 'Uma pergunta da plateia.'],
    ]);
    const sent = await sendTranscript(media, {
      token,
      job: job.json(),
      raw: twoSegments,
    });
    expect(sent.statusCode).toBe(204);

    const speakers = await speakersOf(media, mediaId);
    expect(speakers.status).toBe('waiting');
    expect(speakers.diarization).toMatchObject({
      version: 1,
      transcriptVersion: 2,
      staleTranscript: true,
      segments: [
        { startMs: 0, endMs: 15_000, voice: 2 },
        { startMs: 40_500, endMs: 45_000, voice: 3 },
      ],
    });
    // Separated again on the new transcript: no longer stale.
    const redo = await leaseDiarization(media, token);
    expect((await sendTurns(media, { token, job: redo })).statusCode).toBe(204);
    expect((await speakersOf(media, mediaId)).diarization).toMatchObject({
      version: 2,
      staleTranscript: false,
    });
  });
});

describe('The number of voices (KBC-064 AC-5, AC-6, BR-4)', () => {
  it('says "1 voice" for a recording of one voice, with every segment on it', async () => {
    const media = await startMedia();
    const { token, mediaId } = await ready(media);
    const { speakers } = await separate(media, {
      token,
      mediaId,
      turns: [{ start: 0, end: 60, voice: 'SPEAKER_01' }],
    });
    expect(speakers.diarization?.voiceCount).toBe(1);
    expect(
      new Set(speakers.diarization?.segments.map((one) => one.voice)),
    ).toEqual(new Set([1]));
  });

  it('passes "2 voices" to the transcriber and keeps it with the result', async () => {
    const media = await startMedia();
    const { token, mediaId } = await ready(media);
    const { job, speakers } = await separate(media, {
      token,
      mediaId,
      voices: 2,
      turns: CONVERSATION_TURNS.map((turn) =>
        turn.voice === 'SPEAKER_03' ? { ...turn, voice: 'SPEAKER_02' } : turn,
      ),
    });
    expect(job.voices).toBe(2);
    expect(speakers.diarization).toMatchObject({
      requestedVoices: 2,
      voiceCount: 2,
    });
  });

  it('refuses turns that end after the recording', async () => {
    const media = await startMedia();
    const { token, mediaId } = await ready(media);
    await requestVoices(media, mediaId);
    const job = await leaseDiarization(media, token);
    const late = await sendTurns(media, {
      token,
      job,
      body: turnsOf(job, [{ start: 0, end: 400, voice: 'SPEAKER_01' }]),
    });
    expect(late.statusCode).toBe(400);
  });
});

describe('Transcribers that do not separate voices (KBC-064 AC-9, FR-6)', () => {
  it('never lease a separation, and the item says none separates voices', async () => {
    const media = await startMedia();
    const { token } = await pair(media);
    const mediaId = await transcribedItem(media, token);
    expect(await speakersOf(media, mediaId)).toMatchObject({
      transcriber: 'none',
    });
    expect((await requestVoices(media, mediaId)).statusCode).toBe(202);
    expect((await lease(media, token, ['transcribe'])).statusCode).toBe(204);
    // Asking only for separations is refused: this token may not lease them.
    expect((await lease(media, token, ['diarize'])).statusCode).toBe(403);
    const { status, transcriber } = await speakersOf(media, mediaId);
    expect({ status, transcriber }).toEqual({
      status: 'waiting',
      transcriber: 'none',
    });
  });

  it('lets a master mark a transcriber to separate voices, and only a master', async () => {
    const media = await startMedia();
    const { token, transcriber } = await pair(media);
    const marked = await media.owner(
      'PATCH',
      `/api/v1/media/transcribers/${transcriber.id}`,
      { kinds: ['transcribe', 'diarize', 'diarize'] },
    );
    expect(marked.statusCode).toBe(200);
    expect(marked.json().kinds).toEqual(['transcribe', 'diarize']);
    const mediaId = await transcribedItem(media, token);
    await requestVoices(media, mediaId);
    expect((await lease(media, token)).json().kind).toBe('diarize');

    expect(
      (
        await media.owner(
          'PATCH',
          `/api/v1/media/transcribers/${transcriber.id}`,
          {
            kinds: ['transcode'],
          },
        )
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await media.owner(
          'PATCH',
          '/api/v1/media/transcribers/99999999-9999-4999-8999-999999999999',
          { kinds: ['diarize'] },
        )
      ).statusCode,
    ).toBe(404);
    const { call } = await member(media, {
      email: 'membro@example.com',
      topics: ['hermetismo'],
      features: ['media', 'media-edit'],
    });
    expect(
      (
        await call('PATCH', `/api/v1/media/transcribers/${transcriber.id}`, {
          kinds: ['diarize'],
        })
      ).statusCode,
    ).toBe(403);
  });

  it('keeps the transcription presence of a diarize-only transcriber apart', async () => {
    const media = await startMedia();
    const { token } = await pairDiarizer(media, ['diarize']);
    // It cannot transcribe, so the item still has no transcriber for its transcription.
    const transcriber = await pair(media, 'Mac que transcreve');
    const mediaId = await transcribedItem(media, transcriber.token);
    expect(
      (await media.owner('GET', `/api/v1/media/${mediaId}`)).json()
        .transcription.transcriber,
    ).toBe('on');
    await requestVoices(media, mediaId);
    expect((await leaseDiarization(media, token)).mediaId).toBe(mediaId);
    expect((await speakersOf(media, mediaId)).transcriber).toBe('on');
  });

  it('refuses a separation result from a token that may only transcribe (404)', async () => {
    const media = await startMedia();
    const { token, mediaId } = await ready(media);
    const transcribeOnly = await pair(media, 'Só transcreve');
    await requestVoices(media, mediaId);
    const job = await leaseDiarization(media, token);
    const sent = await sendTurns(media, { token: transcribeOnly.token, job });
    expect(sent.statusCode).toBe(404);
  });
});

describe('The transcriber holds one job at a time (KBC-064 BR-5)', () => {
  it('does not lease a separation while it transcribes', async () => {
    const media = await startMedia();
    const { token, mediaId } = await ready(media);
    await requestVoices(media, mediaId);
    await readyForTranscription(media);
    // Oldest first: the separation was asked before the second item was ready.
    expect((await leaseDiarization(media, token)).mediaId).toBe(mediaId);
    expect((await lease(media, token)).statusCode).toBe(204);
  });
});

describe('Review round 1 (KBC-064)', () => {
  /** Any array of numbers in a text: a vector, whatever key it hides under. */
  const NUMERIC_ARRAY = /\[\s*-?\d/;

  it('refuses parameters that are not plain values, whole, and saves nothing (BR-1)', async () => {
    const media = await startMedia();
    const { token, mediaId } = await ready(media);
    await requestVoices(media, mediaId);
    const job = await leaseDiarization(media, token);
    for (const parameters of [
      { embedding: [0.11, 0.22, 0.33] },
      { centroids: { A: [0.5] } },
      { nested: { threshold: 0.3 } },
    ]) {
      const refused = await sendTurns(media, {
        token,
        job,
        body: { ...turnsOf(job), parameters },
      });
      expect(refused.statusCode).toBe(400);
    }
    expect((await speakersOf(media, mediaId)).diarization).toBeNull();
    const folder = join(media.mediaDir, 'transcripts', mediaId);
    expect(
      readdirSync(folder).filter((name) => name.startsWith('diarization-')),
    ).toEqual([]);
  });

  it('keeps no array of numbers in any separation row or raw file', async () => {
    const media = await startMedia();
    const { token, mediaId } = await ready(media);
    await separate(media, { token, mediaId });
    const db = new DatabaseSync(join(media.mediaDir, 'media.db'));
    const texts = [
      'diarizations',
      'media_speaker_turns',
      'media_segment_voices',
      'media_word_voices',
    ].flatMap((table) =>
      db
        .prepare(`SELECT * FROM ${table}`)
        .all()
        .flatMap((row) => Object.values(row).map(String)),
    );
    db.close();
    expect(texts.length).toBeGreaterThan(0);
    expect(texts.filter((text) => NUMERIC_ARRAY.test(text))).toEqual([]);
    const folder = join(media.mediaDir, 'transcripts', mediaId);
    const raws = readdirSync(folder)
      .filter((name) => name.startsWith('diarization-'))
      .map((name) => readFileSync(join(folder, name), 'utf8'));
    expect(raws).toHaveLength(1);
    expect(raws.filter((raw) => NUMERIC_ARRAY.test(raw))).toEqual([]);
  });

  it('says a failed new run failed, still showing the earlier voices (QA BUG-2)', async () => {
    const media = await startMedia();
    const { token, mediaId } = await ready(media);
    await separate(media, { token, mediaId });
    expect((await requestVoices(media, mediaId)).statusCode).toBe(202);
    {
      const job = await leaseDiarization(media, token);
      const failed = await asTranscriber(media, token, {
        method: 'POST',
        url: `/api/v1/media-worker/jobs/${job.id}/fail`,
        payload: {
          worker: 'mac',
          leaseId: job.leaseId,
          failure: 'invalid-audio',
          detail: 'broken',
        },
      });
      expect(failed.statusCode).toBe(204);
    }
    expect(await speakersOf(media, mediaId)).toMatchObject({
      status: 'failed',
      canRequest: true,
      diarization: { version: 1, voiceCount: 3 },
    });
  });

  it('takes the number of voices from the job, and refuses more voices than asked (AC-6)', async () => {
    const media = await startMedia();
    const { token, mediaId } = await ready(media);
    await requestVoices(media, mediaId, { voices: 2 });
    const job = await leaseDiarization(media, token);
    const tooMany = await sendTurns(media, {
      token,
      job,
      body: { ...turnsOf(job), requestedVoices: 3 },
    });
    expect(tooMany.statusCode).toBe(400);
    const two = CONVERSATION_TURNS.map((turn) =>
      turn.voice === 'SPEAKER_03' ? { ...turn, voice: 'SPEAKER_02' } : turn,
    );
    const lied = await sendTurns(media, {
      token,
      job,
      body: { ...turnsOf(job, two), requestedVoices: null },
    });
    expect(lied.statusCode).toBe(204);
    expect((await speakersOf(media, mediaId)).diarization).toMatchObject({
      requestedVoices: 2,
      voiceCount: 2,
    });
  });

  it('refuses a person with `media-edit` but not `media` (owner decision)', async () => {
    const media = await startMedia();
    const { mediaId } = await ready(media);
    const { call } = await member(media, {
      email: 'so-editor@example.com',
      topics: ['hermetismo'],
      features: ['media-edit'],
    });
    expect(
      (await call('GET', `/api/v1/media/${mediaId}/speakers`)).statusCode,
    ).toBe(403);
    expect(
      (await call('POST', `/api/v1/media/${mediaId}/diarize`, {})).statusCode,
    ).toBe(403);
  });
});

describe('Voices on the transcript (KBC-064 FR-4, AC-2)', () => {
  const transcriptOf = (mediaId: string) =>
    `/api/v1/media/${mediaId}/transcript`;

  it('gives an editor the voice of every segment and the separation', async () => {
    const media = await startMedia();
    const { token, mediaId } = await ready(media);
    await separate(media, { token, mediaId });
    const { call } = await member(media, {
      email: 'editor@example.com',
      topics: ['hermetismo'],
      features: ['media', 'media-edit'],
    });
    const response = await call('GET', transcriptOf(mediaId));
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(
      body.segments.map((one: { voice?: number | null }) => one.voice),
    ).toEqual([1, 2, 1, 2, 3, 2]);
    expect(body.speakers).toMatchObject({
      version: 1,
      transcriptVersion: 1,
      staleTranscript: false,
      voiceCount: 3,
      voices: [
        { voice: 1, speakingMs: 12_100 },
        { voice: 2, speakingMs: 42_900 },
        { voice: 3, speakingMs: 5_000 },
      ],
    });
    expect(body.speakers.turns[0]).toEqual({
      voice: 1,
      startMs: 0,
      endMs: 5_200,
    });
    expect(body.speakers).not.toHaveProperty('segments');
  });

  it('keeps the transcript unchanged for a person with only `media`', async () => {
    const media = await startMedia();
    const { token, mediaId } = await ready(media);
    await separate(media, { token, mediaId });
    const { call } = await member(media, {
      email: 'ouvinte@example.com',
      topics: ['hermetismo'],
      features: ['media'],
    });
    const response = await call('GET', transcriptOf(mediaId));
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body).not.toHaveProperty('speakers');
    expect(body.segments).toHaveLength(6);
    for (const segment of body.segments)
      expect(segment).not.toHaveProperty('voice');
  });

  it('has no voices for an editor before any separation', async () => {
    const media = await startMedia();
    const { mediaId } = await ready(media);
    const body = (await media.owner('GET', transcriptOf(mediaId))).json();
    expect(body).not.toHaveProperty('speakers');
    expect(body.segments[0]).not.toHaveProperty('voice');
  });

  it('places an older separation on the new segments, flagged as stale (AC-4)', async () => {
    const media = await startMedia();
    const { token, mediaId } = await ready(media);
    await separate(media, { token, mediaId });
    await media.owner('POST', `/api/v1/media/${mediaId}/transcription`);
    const job = await lease(media, token);
    const sent = await sendTranscript(media, {
      token,
      job: job.json(),
      raw: conversationRaw([
        [0, 15, 'Mestre, o senhor está lembrado? Eu lembro sim.'],
        [40.5, 45, 'Uma pergunta da plateia.'],
      ]),
    });
    expect(sent.statusCode).toBe(204);
    const body = (await media.owner('GET', transcriptOf(mediaId))).json();
    expect(body.version).toBe(2);
    expect(body.speakers).toMatchObject({
      transcriptVersion: 2,
      staleTranscript: true,
    });
    expect(
      body.segments.map((one: { voice?: number | null }) => one.voice),
    ).toEqual([2, 3]);
  });
});
