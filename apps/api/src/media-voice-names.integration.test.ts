import type {
  CollectionSpeaker,
  MediaSpeakers,
  MediaTranscript,
  RawSpeakerTurn,
} from '@kb-chat/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { closeApp } from '../test/ai-app-harness.js';
import {
  CONVERSATION_TURNS,
  conversationRaw,
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
  leaseTranscription,
  sendTranscript,
} from '../test/transcription-harness.js';

afterEach(closeApp);

const SPEAKERS = '/api/v1/topics/hermetismo/speakers';

/** Four voices: the same interview, the audience's voice cut in two. */
const FOUR_VOICES: readonly RawSpeakerTurn[] = [
  ...CONVERSATION_TURNS.slice(0, 4),
  { start: 40.3, end: 43, voice: 'SPEAKER_03' },
  { start: 43, end: 45.3, voice: 'SPEAKER_04' },
  { start: 45.3, end: 60, voice: 'SPEAKER_01' },
];

async function separate(
  media: Media,
  input: {
    token: string;
    mediaId: string;
    turns?: readonly RawSpeakerTurn[];
  },
): Promise<MediaSpeakers> {
  expect((await requestVoices(media, input.mediaId)).statusCode).toBe(202);
  const job = await leaseDiarization(media, input.token);
  const sent = await sendTurns(media, {
    token: input.token,
    job,
    body: turnsOf(job, input.turns ?? CONVERSATION_TURNS),
  });
  expect(sent.statusCode).toBe(204);
  return speakersOf(media, input.mediaId);
}

/** An item with its voices separated; `token` for separating it again. */
async function separated(
  media: Media,
  turns: readonly RawSpeakerTurn[] = CONVERSATION_TURNS,
) {
  const { token } = await pairDiarizer(media);
  const mediaId = await transcribedItem(media, token);
  await separate(media, { token, mediaId, turns });
  return { token, mediaId };
}

async function aSpeaker(media: Media, name: string, authorSlug?: string) {
  const created = await media.owner('POST', SPEAKERS, {
    name,
    ...(authorSlug && { authorSlug }),
  });
  expect(created.statusCode, created.body).toBe(201);
  return created.json<CollectionSpeaker>();
}

const nameVoice = (
  media: Media,
  [mediaId, voice]: readonly [mediaId: string, voice: number],
  body: {
    speakerId?: string | null;
    audience?: boolean;
    version?: number;
  } = {},
) =>
  media.owner('PUT', `/api/v1/media/${mediaId}/voices/${voice}`, {
    version: 1,
    speakerId: null,
    audience: false,
    ...body,
  });

const transcriptOf = async (call: Media['owner'], mediaId: string) => {
  const read = await call('GET', `/api/v1/media/${mediaId}/transcript`);
  expect(read.statusCode).toBe(200);
  return read.json<MediaTranscript>();
};

const listener = (media: Media, email = 'ouve@example.com') =>
  member(media, {
    email,
    topics: ['hermetismo'],
    features: ['media', 'media-speakers'],
  });

describe('Naming the voices (KBC-065 AC-1, FR-2, FR-4)', () => {
  it('AC-1: a listener with `media-speakers` reads the main author and the audience', async () => {
    const media = await startMedia();
    const { mediaId } = await separated(media);
    const master = await aSpeaker(media, 'Mestre', 'mestre-laercio');
    // Voice 2 answers in CONVERSATION; voices 1 and 3 ask.
    expect(
      (await nameVoice(media, [mediaId, 2], { speakerId: master.id }))
        .statusCode,
    ).toBe(200);
    await nameVoice(media, [mediaId, 1], { audience: true });
    const saved = await nameVoice(media, [mediaId, 3], { audience: true });
    expect(saved.json<MediaSpeakers>().diarization?.labels).toEqual([
      expect.objectContaining({ voice: 1, kind: 'audience', name: null }),
      {
        voice: 2,
        kind: 'person',
        speakerId: master.id,
        name: 'Mestre Laércio',
        main: true,
      },
      expect.objectContaining({ voice: 3, kind: 'audience', name: null }),
    ]);

    const { call } = await listener(media);
    const read = await transcriptOf(call, mediaId);
    expect(read.segments.map((segment) => segment.voice)).toEqual([
      1, 2, 1, 2, 3, 2,
    ]);
    expect(read.voiceNames).toEqual(saved.json().diarization.labels);
    expect(read).not.toHaveProperty('speakers');
  });

  it('NFR-1: a name is saved within 300 ms and shows on the next opening', async () => {
    const media = await startMedia();
    const { mediaId } = await separated(media);
    const gabriel = await aSpeaker(media, 'Mestre Gabriel');
    const times: number[] = [];
    for (let round = 19; round >= 0; round--) {
      const speakerId = round % 2 === 0 ? gabriel.id : null;
      const started = performance.now();
      const saved = await nameVoice(media, [mediaId, 2], { speakerId });
      times.push(performance.now() - started);
      expect(saved.statusCode).toBe(200);
    }
    // p95 of 20: one pause of a busy machine must not read as a slow save.
    expect(times.sort((a, b) => a - b).at(18)).toBeLessThan(300);
    const { call } = await listener(media);
    const names = (await transcriptOf(call, mediaId)).voiceNames;
    expect(names?.[1]).toMatchObject({ name: 'Mestre Gabriel', main: false });
  });

  it('keeps the names through a new transcription, on the new segments (KBC-040)', async () => {
    const media = await startMedia();
    const { mediaId, token } = await separated(media);
    const gabriel = await aSpeaker(media, 'Mestre Gabriel');
    await nameVoice(media, [mediaId, 2], { speakerId: gabriel.id });
    await media.owner('POST', `/api/v1/media/${mediaId}/transcription`);
    const job = await leaseTranscription(media, token);

    await sendTranscript(media, {
      token,
      job,
      raw: conversationRaw([[5.5, 15, 'Eu lembro sim, foi numa sessão.']]),
    });

    const { call } = await listener(media);
    const read = await transcriptOf(call, mediaId);
    expect(read.version).toBe(2);
    expect(read.segments.map((one) => one.voice)).toEqual([2]);
    expect(read.voiceNames?.[1]).toMatchObject({ name: 'Mestre Gabriel' });
  });

  it('takes a name away and refuses a speaker of another collection or an unknown voice', async () => {
    const media = await startMedia();
    const { mediaId } = await separated(media);
    const gabriel = await aSpeaker(media, 'Mestre Gabriel');
    await nameVoice(media, [mediaId, 2], { speakerId: gabriel.id });
    const cleared = await nameVoice(media, [mediaId, 2], {});
    expect(cleared.json().diarization.labels[1].kind).toBe('unnamed');
    const unknown = await nameVoice(media, [mediaId, 2], {
      speakerId: '00000000-0000-4000-8000-000000000000',
    });
    expect(unknown.statusCode).toBe(400);
    expect((await nameVoice(media, [mediaId, 9])).statusCode).toBe(404);
    const both = await nameVoice(media, [mediaId, 2], {
      speakerId: gabriel.id,
      audience: true,
    });
    expect(both.statusCode).toBe(400);
  });

  it('refuses a change made on an older separation (409), and with none (409)', async () => {
    const media = await startMedia();
    const { token, mediaId } = await separated(media);
    await separate(media, { token, mediaId });
    const old = await nameVoice(media, [mediaId, 1], { version: 1 });
    expect(old.statusCode).toBe(409);
    expect(
      (await nameVoice(media, [mediaId, 1], { version: 2 })).statusCode,
    ).toBe(200);
    const fresh = await transcribedItem(media, token);
    expect((await nameVoice(media, [fresh, 1])).statusCode).toBe(409);
  });
});

describe('Joining two voices (KBC-065 AC-3, FR-2)', () => {
  const merge = (
    media: Media,
    mediaId: string,
    [voice, into]: readonly [voice: number, into: number],
  ) =>
    media.owner('POST', `/api/v1/media/${mediaId}/voices/merge`, {
      version: 1,
      voice,
      into,
    });

  it('AC-3: reads as one speaker everywhere, and the join can be undone', async () => {
    const media = await startMedia();
    const { mediaId } = await separated(media, FOUR_VOICES);
    expect((await speakersOf(media, mediaId)).diarization?.voiceCount).toBe(4);
    const gabriel = await aSpeaker(media, 'Mestre Gabriel');
    await nameVoice(media, [mediaId, 4], { speakerId: gabriel.id });

    const merged = await merge(media, mediaId, [4, 3]);
    expect(merged.statusCode, merged.body).toBe(200);
    const { diarization } = merged.json<MediaSpeakers>();
    expect(diarization).toMatchObject({
      voiceCount: 3,
      merged: [{ voice: 4, into: 3 }],
    });
    expect(diarization?.voices.map(({ voice }) => voice)).toEqual([1, 2, 3]);
    // Back-to-back turns of the joined voices become one, with both times.
    expect(diarization?.turns.at(-2)).toEqual({
      voice: 3,
      startMs: 40_300,
      endMs: 45_300,
    });
    // The voice kept had no name: it takes the joined one's.
    expect(diarization?.labels[2]).toMatchObject({ name: 'Mestre Gabriel' });
    const read = await transcriptOf(media.owner, mediaId);
    expect(read.segments.map((segment) => segment.voice)).toEqual([
      1, 2, 1, 2, 3, 2,
    ]);

    const split = await media.owner(
      'POST',
      `/api/v1/media/${mediaId}/voices/split`,
      { version: 1, voice: 4 },
    );
    expect(split.statusCode).toBe(200);
    expect(split.json().diarization).toMatchObject({
      voiceCount: 4,
      merged: [],
    });
    // The undo gives each voice back what it had: the kept one had no name.
    expect(split.json().diarization.labels).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ voice: 3, kind: 'unnamed', name: null }),
        expect.objectContaining({ voice: 4, name: 'Mestre Gabriel' }),
      ]),
    );
    const undone = await transcriptOf(media.owner, mediaId);
    expect(undone.voiceNames).toEqual(split.json().diarization.labels);
  });

  const splitVoice = (media: Media, mediaId: string, voice: number) =>
    media.owner('POST', `/api/v1/media/${mediaId}/voices/split`, {
      version: 1,
      voice,
    });
  const namesOf = (read: { json: () => unknown }) =>
    Object.fromEntries(
      (read.json() as MediaSpeakers).diarization?.labels.map((label) => [
        label.voice,
        label.name ?? label.kind,
      ]) ?? [],
    );

  it('undoes a name carried by the join, and an audience too', async () => {
    const media = await startMedia();
    const { mediaId } = await separated(media, FOUR_VOICES);
    await nameVoice(media, [mediaId, 4], { audience: true });
    await merge(media, mediaId, [4, 3]);
    const split = await splitVoice(media, mediaId, 4);
    expect(namesOf(split)).toMatchObject({ 3: 'unnamed', 4: 'audience' });
  });

  it('keeps on the undo a name the kept voice already had or was given after the join', async () => {
    const media = await startMedia();
    const { mediaId } = await separated(media, FOUR_VOICES);
    const ana = await aSpeaker(media, 'Ana');
    const bia = await aSpeaker(media, 'Bia');
    await nameVoice(media, [mediaId, 1], { speakerId: ana.id });
    await nameVoice(media, [mediaId, 2], { speakerId: bia.id });
    await merge(media, mediaId, [2, 1]);
    expect(namesOf(await splitVoice(media, mediaId, 2))).toMatchObject({
      1: 'Ana',
      2: 'Bia',
    });

    await nameVoice(media, [mediaId, 1], { speakerId: null });
    await merge(media, mediaId, [2, 1]);
    await nameVoice(media, [mediaId, 1], { speakerId: ana.id });
    expect(namesOf(await splitVoice(media, mediaId, 2))).toMatchObject({
      1: 'Ana',
      2: 'Bia',
    });
  });

  it('keeps the kept voice named by another voice still joined to it', async () => {
    const media = await startMedia();
    const { mediaId } = await separated(media, FOUR_VOICES);
    const ana = await aSpeaker(media, 'Ana');
    const bia = await aSpeaker(media, 'Bia');
    await nameVoice(media, [mediaId, 3], { speakerId: ana.id });
    await nameVoice(media, [mediaId, 4], { speakerId: bia.id });
    await merge(media, mediaId, [3, 1]);
    await merge(media, mediaId, [4, 1]);
    expect(namesOf(await splitVoice(media, mediaId, 3))).toMatchObject({
      1: 'Bia',
      3: 'Ana',
    });
    expect(namesOf(await splitVoice(media, mediaId, 4))).toMatchObject({
      1: 'unnamed',
      4: 'Bia',
    });
  });

  it('undoes a chain of joins one voice at a time', async () => {
    const media = await startMedia();
    const { mediaId } = await separated(media, FOUR_VOICES);
    const ana = await aSpeaker(media, 'Ana');
    await nameVoice(media, [mediaId, 4], { speakerId: ana.id });
    await merge(media, mediaId, [4, 3]);
    await merge(media, mediaId, [3, 2]);
    expect(namesOf(await splitVoice(media, mediaId, 3))).toMatchObject({
      2: 'Ana',
      3: 'unnamed',
    });
    expect(namesOf(await splitVoice(media, mediaId, 4))).toMatchObject({
      2: 'unnamed',
      3: 'unnamed',
      4: 'Ana',
    });
  });

  it('joins a chain into the last voice and refuses a joined or unknown voice', async () => {
    const media = await startMedia();
    const { mediaId } = await separated(media, FOUR_VOICES);
    await merge(media, mediaId, [4, 3]);
    const chain = await merge(media, mediaId, [3, 2]);
    expect(chain.json().diarization.merged).toEqual([
      { voice: 3, into: 2 },
      { voice: 4, into: 2 },
    ]);
    expect((await merge(media, mediaId, [4, 1])).statusCode).toBe(409);
    expect((await merge(media, mediaId, [1, 4])).statusCode).toBe(409);
    expect((await nameVoice(media, [mediaId, 4])).statusCode).toBe(409);
    expect((await merge(media, mediaId, [1, 9])).statusCode).toBe(404);
    expect((await merge(media, mediaId, [1, 1])).statusCode).toBe(400);
  });
});

describe('Who may see and change names (KBC-065 AC-4, AC-5, BR-4, BR-6)', () => {
  it('AC-4: without `media-speakers` the transcript is as before; without `media-edit`, 403', async () => {
    const media = await startMedia();
    const { mediaId } = await separated(media);
    const gabriel = await aSpeaker(media, 'Mestre Gabriel');
    await nameVoice(media, [mediaId, 2], { speakerId: gabriel.id });
    const { call } = await member(media, {
      email: 'so-ouve@example.com',
      topics: ['hermetismo'],
      features: ['media'],
    });
    const plain = await transcriptOf(call, mediaId);
    expect(plain).not.toHaveProperty('voiceNames');
    expect(plain.segments[0]).not.toHaveProperty('voice');
    const body = { version: 1, speakerId: null, audience: false };
    expect(
      (await call('PUT', `/api/v1/media/${mediaId}/voices/1`, body)).statusCode,
    ).toBe(403);
    const withNames = await listener(media);
    expect(
      (await withNames.call('PUT', `/api/v1/media/${mediaId}/voices/1`, body))
        .statusCode,
    ).toBe(403);
    expect(
      (
        await withNames.call('POST', `/api/v1/media/${mediaId}/voices/merge`, {
          version: 1,
          voice: 1,
          into: 2,
        })
      ).statusCode,
    ).toBe(403);
    expect((await withNames.call('GET', SPEAKERS)).statusCode).toBe(403);
    const noAudio = await member(media, {
      email: 'sem-audio@example.com',
      topics: ['hermetismo'],
      features: ['media-speakers'],
    });
    expect(
      (await noAudio.call('GET', `/api/v1/media/${mediaId}/transcript`))
        .statusCode,
    ).toBe(403);
  });

  it('AC-5: a voice with no name comes unnamed to whoever only listens', async () => {
    const media = await startMedia();
    const { mediaId } = await separated(media);
    const { call } = await listener(media);
    const names = (await transcriptOf(call, mediaId)).voiceNames;
    expect(names).toHaveLength(3);
    expect(names?.every(({ kind }) => kind === 'unnamed')).toBe(true);
  });

  it('an editor without `media-speakers` sees the names too', async () => {
    const media = await startMedia();
    const { mediaId } = await separated(media);
    const gabriel = await aSpeaker(media, 'Mestre Gabriel');
    await nameVoice(media, [mediaId, 2], { speakerId: gabriel.id });
    const { call } = await member(media, {
      email: 'edita@example.com',
      topics: ['hermetismo'],
      features: ['media', 'media-edit'],
    });
    const read = await transcriptOf(call, mediaId);
    expect(read.voiceNames?.[1]?.name).toBe('Mestre Gabriel');
    expect(read.speakers?.labels[1]?.name).toBe('Mestre Gabriel');
  });

  it('a listener on an item of a collection they do not see gets 404', async () => {
    const media = await startMedia();
    const { mediaId } = await separated(media);
    const { call } = await member(media, {
      email: 'fora@example.com',
      topics: [],
      features: ['media', 'media-speakers', 'media-edit'],
    });
    const read = await call('GET', `/api/v1/media/${mediaId}/transcript`);
    expect(read.statusCode).toBe(404);
    const put = await call('PUT', `/api/v1/media/${mediaId}/voices/1`, {
      version: 1,
      speakerId: null,
      audience: false,
    });
    expect(put.statusCode).toBe(404);
  });
});

describe('A new separation (KBC-065 AC-6, FR-5, BR-5)', () => {
  it('AC-6: comes with the names filled in, waiting for a person, hidden from listeners', async () => {
    const media = await startMedia();
    const { token, mediaId } = await separated(media);
    const gabriel = await aSpeaker(media, 'Mestre Gabriel');
    await nameVoice(media, [mediaId, 2], { speakerId: gabriel.id });
    await nameVoice(media, [mediaId, 3], { audience: true });
    const { call } = await listener(media);
    expect((await transcriptOf(call, mediaId)).voiceNames?.[1]?.name).toBe(
      'Mestre Gabriel',
    );

    const again = await separate(media, { token, mediaId });
    expect(again.diarization).toMatchObject({ version: 2, namesPending: true });
    expect(again.diarization?.labels[1]?.name).toBe('Mestre Gabriel');
    expect(again.diarization?.labels[2]?.kind).toBe('audience');
    expect(
      (await transcriptOf(call, mediaId)).voiceNames?.map(({ kind }) => kind),
    ).toEqual(['unnamed', 'unnamed', 'unnamed']);

    const confirmed = await media.owner(
      'POST',
      `/api/v1/media/${mediaId}/voices/confirm`,
      { version: 2 },
    );
    expect(confirmed.statusCode).toBe(200);
    expect(confirmed.json().diarization.namesPending).toBe(false);
    expect((await transcriptOf(call, mediaId)).voiceNames?.[1]?.name).toBe(
      'Mestre Gabriel',
    );
  });

  it('asks nothing when no voice had a name', async () => {
    const media = await startMedia();
    const { token, mediaId } = await separated(media);
    const again = await separate(media, { token, mediaId });
    expect(again.diarization?.namesPending).toBe(false);
  });
});
