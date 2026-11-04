import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { closeApp } from '../test/ai-app-harness.js';
import {
  member,
  readyItem,
  startMedia,
  type Media,
} from '../test/media-harness.js';
import {
  leaseTranscription,
  pair,
  readyForTranscription,
  sendTranscript,
} from '../test/transcription-harness.js';

afterEach(closeApp);

const track = (
  startMs: number,
  endMs: number,
  title: string | null = 'Tema',
) => ({
  id: randomUUID(),
  source: 'manual',
  startMs,
  endMs,
  kind: 'qa',
  title,
  askerVoice: null,
  answererVoice: null,
  askerSpeakerId: null as string | null,
  answererSpeakerId: null as string | null,
});

type Track = ReturnType<typeof track>;

/** The session of a writer, and how to send it a version. */
interface Writer {
  readonly media: Media;
  readonly headers: Record<string, string>;
}

const write = (
  writer: Writer,
  input: {
    method: 'PUT' | 'POST';
    url: string;
    payload: object;
    version: number;
  },
) =>
  writer.media.started.app.inject({
    method: input.method,
    url: input.url,
    payload: input.payload,
    headers: { ...writer.headers, 'if-match': `"${input.version}"` },
  });

const put = (
  writer: Writer,
  id: string,
  input: { version: number; tracks: Track[] },
) =>
  write(writer, {
    method: 'PUT',
    url: `/api/v1/media/${id}/edit`,
    payload: { tracks: input.tracks, step: 3 },
    version: input.version,
  });

const post = (
  writer: Writer,
  input: { id: string; action: string; version: number },
) =>
  write(writer, {
    method: 'POST',
    url: `/api/v1/media/${input.id}/edit/${input.action}`,
    payload: {},
    version: input.version,
  });

const ownerOf = (media: Media): Writer => ({
  media,
  headers: media.ownerHeaders,
});

async function transcribed(media: Media) {
  const { token } = await pair(media);
  const item = await readyForTranscription(media);
  const job = await leaseTranscription(media, token);
  expect((await sendTranscript(media, { token, job })).statusCode).toBe(204);
  return { item, token };
}

describe('The draft (KBC-066 FR-1)', () => {
  it('starts empty, saves with If-Match and reads back the same tracks and step', async () => {
    const media = await startMedia();
    const { item } = await transcribed(media);
    const first = await media.owner('GET', `/api/v1/media/${item.id}/edit`);
    expect(first.statusCode).toBe(200);
    expect(first.headers.etag).toBe('"0"');
    expect(first.json()).toMatchObject({
      version: 0,
      started: false,
      status: 'draft',
      step: 3,
      tracks: [],
      approvedTracks: 0,
    });

    const one = track(10_000, 20_000, '  O que é?  ');
    const saved = await put(ownerOf(media), item.id, {
      version: 0,
      tracks: [one],
    });
    expect(saved.statusCode, saved.body).toBe(200);
    expect(saved.json()).toEqual({ version: 1 });

    const read = await media.owner('GET', `/api/v1/media/${item.id}/edit`);
    expect(read.headers.etag).toBe('"1"');
    expect(read.json().started).toBe(true);
    expect(read.json().tracks).toEqual([
      expect.objectContaining({
        id: one.id,
        startMs: 10_000,
        endMs: 20_000,
        title: 'O que é?',
        source: 'manual',
        firstSegment: null,
      }),
    ]);
  });

  it('asks for the version it read (428) and refuses an old one (412, AC-15)', async () => {
    const media = await startMedia();
    const { item } = await transcribed(media);
    const missing = await media.owner('PUT', `/api/v1/media/${item.id}/edit`, {
      tracks: [],
      step: 3,
    });
    expect(missing.statusCode).toBe(428);
    expect(missing.json().error.code).toBe('EDIT_VERSION_REQUIRED');

    const tracks = [track(0, 6_000)];
    await put(ownerOf(media), item.id, { version: 0, tracks });
    const late = await put(ownerOf(media), item.id, { version: 0, tracks: [] });
    expect(late.statusCode).toBe(412);
    expect(late.json().error.code).toBe('EDIT_STALE');
    const read = await media.owner('GET', `/api/v1/media/${item.id}/edit`);
    expect(read.json().tracks).toHaveLength(1);
  });

  it('refuses overlapping tracks and one of 4 s, pointing at the track (AC-6)', async () => {
    const media = await startMedia();
    const { item } = await transcribed(media);
    const a = track(0, 10_000);
    const b = track(9_000, 20_000);
    const overlap = await put(ownerOf(media), item.id, {
      version: 0,
      tracks: [a, b],
    });
    expect(overlap.statusCode).toBe(422);
    expect(overlap.json().error.details.problems).toEqual([
      { trackId: b.id, ordinal: 2, problem: 'overlap' },
    ]);
    const short = track(0, 4_000);
    const tooShort = await put(ownerOf(media), item.id, {
      version: 0,
      tracks: [short],
    });
    expect(tooShort.statusCode).toBe(422);
    expect(tooShort.json().error.details.problems).toEqual([
      { trackId: short.id, ordinal: 1, problem: 'short' },
    ]);
  });

  it('refuses a speaker of another collection', async () => {
    const media = await startMedia();
    const { item } = await transcribed(media);
    const refused = await put(ownerOf(media), item.id, {
      version: 0,
      tracks: [{ ...track(0, 6_000), askerSpeakerId: randomUUID() }],
    });
    expect(refused.statusCode).toBe(400);
  });
});

describe('A track id belongs to one recording (FR-1)', () => {
  it('refuses a repeated id with 400 and keeps the draft', async () => {
    const media = await startMedia();
    const { item } = await transcribed(media);
    const one = track(0, 6_000);
    await put(ownerOf(media), item.id, { version: 0, tracks: [one] });
    const twice = await put(ownerOf(media), item.id, {
      version: 1,
      tracks: [one, { ...track(6_000, 12_000), id: one.id }],
    });
    expect(twice.statusCode).toBe(400);
    const read = await media.owner('GET', `/api/v1/media/${item.id}/edit`);
    expect(read.json().version).toBe(1);
    expect(read.json().tracks).toHaveLength(1);
  });

  it('refuses an id of another recording`s draft and leaves that draft alone', async () => {
    const media = await startMedia();
    const { item } = await transcribed(media);
    const other = await readyItem(media);
    const theirs = track(0, 6_000, 'Da outra gravação');
    await put(ownerOf(media), other.id, { version: 0, tracks: [theirs] });
    const refused = await put(ownerOf(media), item.id, {
      version: 0,
      tracks: [{ ...theirs, title: 'Tomada' }],
    });
    expect(refused.statusCode).toBe(400);
    const read = await media.owner('GET', `/api/v1/media/${other.id}/edit`);
    expect(read.json().tracks[0].title).toBe('Da outra gravação');
  });

  it('refuses an id another recording approved, even gone from its draft', async () => {
    const media = await startMedia();
    const { item } = await transcribed(media);
    const other = await readyItem(media);
    const theirs = track(0, 6_000, 'Aprovada');
    const writer = ownerOf(media);
    await put(writer, other.id, { version: 0, tracks: [theirs] });
    await post(writer, { id: other.id, action: 'approve', version: 1 });
    await post(writer, { id: other.id, action: 'reopen', version: 2 });
    const emptied = await put(writer, other.id, {
      version: 3,
      tracks: [track(10_000, 16_000)],
    });
    expect(emptied.statusCode, emptied.body).toBe(200);
    const refused = await put(writer, item.id, {
      version: 0,
      tracks: [theirs],
    });
    expect(refused.statusCode).toBe(400);
  });

  it('takes back a track of its own recording after an approval dropped it', async () => {
    const media = await startMedia();
    const { item } = await transcribed(media);
    const one = track(0, 6_000);
    const writer = ownerOf(media);
    await put(writer, item.id, { version: 0, tracks: [one] });
    await post(writer, { id: item.id, action: 'approve', version: 1 });
    await post(writer, { id: item.id, action: 'reopen', version: 2 });
    await put(writer, item.id, { version: 3, tracks: [] });
    const back = await put(writer, item.id, { version: 4, tracks: [one] });
    expect(back.statusCode, back.body).toBe(200);
  });
});

describe('Approving (KBC-066 FR-2, BR-1)', () => {
  it('shows listeners nothing until a person approves, then only what was approved (AC-1, AC-12)', async () => {
    const media = await startMedia();
    const { item } = await transcribed(media);
    const listener = await member(media, {
      email: 'ouvinte@example.com',
      topics: [item.topic],
      features: ['media', 'media-tracks'],
    });
    const tracks = [track(0, 10_000, 'Um'), track(10_000, 20_000, 'Dois')];
    await put(ownerOf(media), item.id, { version: 0, tracks });
    const before = await listener.call(
      'GET',
      `/api/v1/media/${item.id}/tracks`,
    );
    expect(before.statusCode).toBe(200);
    expect(before.json()).toEqual({ tracks: [] });

    const approved = await post(ownerOf(media), {
      id: item.id,
      action: 'approve',
      version: 1,
    });
    expect(approved.statusCode, approved.body).toBe(200);
    expect(approved.json()).toEqual({ version: 2, tracks: 2 });

    const after = await listener.call('GET', `/api/v1/media/${item.id}/tracks`);
    expect(after.json().tracks).toEqual([
      {
        id: tracks[0]?.id,
        ordinal: 1,
        startMs: 0,
        endMs: 10_000,
        kind: 'qa',
        title: 'Um',
      },
      {
        id: tracks[1]?.id,
        ordinal: 2,
        startMs: 10_000,
        endMs: 20_000,
        kind: 'qa',
        title: 'Dois',
      },
    ]);
    const read = await media.owner('GET', `/api/v1/media/${item.id}/edit`);
    expect(read.json()).toMatchObject({
      status: 'approved',
      step: 4,
      approvedTracks: 2,
    });
  });

  it('refuses an untitled track, pointing at it, and approves nothing (AC-11)', async () => {
    const media = await startMedia();
    const { item } = await transcribed(media);
    const untitled = track(5_000, 12_000, null);
    await put(ownerOf(media), item.id, {
      version: 0,
      tracks: [untitled],
    });
    const refused = await post(ownerOf(media), {
      id: item.id,
      action: 'approve',
      version: 1,
    });
    expect(refused.statusCode).toBe(422);
    expect(refused.json().error.details.problems).toEqual([
      { trackId: untitled.id, ordinal: 1, problem: 'title' },
    ]);
    const read = await media.owner('GET', `/api/v1/media/${item.id}/edit`);
    expect(read.json()).toMatchObject({ status: 'draft', approvedTracks: 0 });
  });

  it('tells who is late after an approval with 412, not 409 (FR-10, AC-15)', async () => {
    const media = await startMedia();
    const { item } = await transcribed(media);
    const one = track(0, 10_000);
    const writer = ownerOf(media);
    await put(writer, item.id, { version: 0, tracks: [one] });
    await post(writer, { id: item.id, action: 'approve', version: 1 });
    const late = await put(writer, item.id, { version: 1, tracks: [one] });
    expect(late.statusCode).toBe(412);
    const lateApproval = await post(writer, {
      id: item.id,
      action: 'approve',
      version: 1,
    });
    expect(lateApproval.statusCode).toBe(412);
  });

  it('answers 409 with the reason to who holds the version of an approved edit', async () => {
    const media = await startMedia();
    const { item } = await transcribed(media);
    const one = track(0, 10_000);
    const writer = ownerOf(media);
    await put(writer, item.id, { version: 0, tracks: [one] });
    await post(writer, { id: item.id, action: 'approve', version: 1 });
    const refused = await put(writer, item.id, { version: 2, tracks: [one] });
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error.details.reason).toBe('approved');
  });

  it('refuses an approval of no tracks', async () => {
    const media = await startMedia();
    const { item } = await transcribed(media);
    await put(ownerOf(media), item.id, { version: 0, tracks: [] });
    const refused = await post(ownerOf(media), {
      id: item.id,
      action: 'approve',
      version: 1,
    });
    expect(refused.statusCode).toBe(422);
  });

  it('keeps listeners on the old tracks until a new approval (AC-16)', async () => {
    const media = await startMedia();
    const { item } = await transcribed(media);
    const one = track(0, 10_000, 'Antiga');
    await put(ownerOf(media), item.id, { version: 0, tracks: [one] });
    await post(ownerOf(media), { id: item.id, action: 'approve', version: 1 });

    const blocked = await put(ownerOf(media), item.id, {
      version: 2,
      tracks: [],
    });
    expect(blocked.statusCode).toBe(409);

    const reopened = await post(ownerOf(media), {
      id: item.id,
      action: 'reopen',
      version: 2,
    });
    expect(reopened.json()).toEqual({ version: 3 });
    const read = await media.owner('GET', `/api/v1/media/${item.id}/edit`);
    expect(read.json()).toMatchObject({ status: 'draft', step: 3 });
    expect(read.json().tracks[0].title).toBe('Antiga');

    await put(ownerOf(media), item.id, {
      version: 3,
      tracks: [{ ...one, title: 'Nova' }],
    });
    const during = await media.owner('GET', `/api/v1/media/${item.id}/tracks`);
    expect(during.json().tracks[0].title).toBe('Antiga');

    await post(ownerOf(media), { id: item.id, action: 'approve', version: 4 });
    const after = await media.owner('GET', `/api/v1/media/${item.id}/tracks`);
    expect(after.json().tracks[0].title).toBe('Nova');
  });

  it('says the transcript changed and keeps the tracks as they were (BR-10, AC-16)', async () => {
    const media = await startMedia();
    const { item, token } = await transcribed(media);
    const one = track(0, 10_000);
    await put(ownerOf(media), item.id, { version: 0, tracks: [one] });
    await post(ownerOf(media), { id: item.id, action: 'approve', version: 1 });
    const again = await media.owner(
      'POST',
      `/api/v1/media/${item.id}/transcription`,
      {},
    );
    expect(again.statusCode, again.body).toBeLessThan(300);
    const job = await leaseTranscription(media, token);
    await sendTranscript(media, { token, job });
    const read = await media.owner('GET', `/api/v1/media/${item.id}/edit`);
    expect(read.json().transcriptChanged).toBe(true);
    const tracks = await media.owner('GET', `/api/v1/media/${item.id}/tracks`);
    expect(tracks.json().tracks[0].startMs).toBe(0);
  });
});

describe('Permissions (KBC-066 BR-8, AC-13)', () => {
  it('needs media-edit to read, save, approve and reopen', async () => {
    const media = await startMedia();
    const { item } = await transcribed(media);
    const { call, headers } = await member(media, {
      email: 'so-ouve@example.com',
      topics: [item.topic],
      features: ['media', 'media-tracks'],
    });
    const listener = { media, headers };
    const url = `/api/v1/media/${item.id}/edit`;
    expect((await call('GET', url)).statusCode).toBe(403);
    expect(
      (await put(listener, item.id, { version: 0, tracks: [] })).statusCode,
    ).toBe(403);
    expect(
      (await post(listener, { id: item.id, action: 'approve', version: 0 }))
        .statusCode,
    ).toBe(403);
    expect((await call('GET', `${url}/words`)).statusCode).toBe(403);
  });

  it('needs media-tracks, and media, for the approved tracks', async () => {
    const media = await startMedia();
    const { item } = await transcribed(media);
    const url = `/api/v1/media/${item.id}/tracks`;
    const noTracks = await member(media, {
      email: 'sem-faixas@example.com',
      topics: [item.topic],
      features: ['media'],
    });
    expect((await noTracks.call('GET', url)).statusCode).toBe(403);
    const noMedia = await member(media, {
      email: 'sem-midia@example.com',
      topics: [item.topic],
      features: ['media-tracks'],
    });
    expect((await noMedia.call('GET', url)).statusCode).toBe(403);
  });

  it('hides the edit of a collection the person does not see', async () => {
    const media = await startMedia();
    const { item } = await transcribed(media);
    const { call } = await member(media, {
      email: 'outro@example.com',
      topics: [],
      features: ['media', 'media-edit'],
    });
    const read = await call('GET', `/api/v1/media/${item.id}/edit`);
    expect(read.statusCode).toBe(404);
  });
});

describe('Words (KBC-066 BR-2)', () => {
  it('serves the current words as tuples', async () => {
    const media = await startMedia();
    const { item } = await transcribed(media);
    const read = await media.owner(
      'GET',
      `/api/v1/media/${item.id}/edit/words`,
    );
    expect(read.statusCode).toBe(200);
    const { version, words } = read.json();
    expect(version).toBe(1);
    expect(words[0]).toEqual([
      expect.any(Number),
      expect.any(Number),
      expect.any(String),
    ]);
  });
});
