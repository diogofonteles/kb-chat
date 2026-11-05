import { randomUUID } from 'node:crypto';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { MediaItem } from '@kb-chat/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { closeApp } from '../test/ai-app-harness.js';
import { member, type Media } from '../test/media-harness.js';
import {
  approve,
  finishCut,
  finishCuts,
  leaseCut,
  libraryEntry,
  say,
  startWorld,
  transcribed,
  withVersion,
  type World,
} from '../test/track-items-harness.js';

afterEach(closeApp);

const THREE = [
  { startMs: 0, endMs: 60_000, title: 'Primeira pergunta' },
  { startMs: 60_000, endMs: 240_000, title: 'Segunda pergunta' },
  { startMs: 300_000, endMs: 360_000, title: 'Terceira pergunta' },
];

const SPEECH = [
  { at: 10, text: 'abertura da palestra' },
  { at: 100, text: 'hoasca na segunda faixa' },
  { at: 270, text: 'intervalo sem faixa nenhuma' },
  { at: 310, text: 'mariri na terceira faixa' },
];

const LISTENER = ['media', 'media-tracks', 'media-library', 'search'];

const urlOf = (id: string) => `/api/v1/media/${id}`;

async function published(world: World, tracks = THREE) {
  const { media } = world;
  const recording = await transcribed(world, SPEECH);
  await approve(media, recording.id, tracks);
  await finishCuts(media);
  const entry = await libraryEntry(media.owner, recording.id);
  return { recording, tracks: entry?.tracks ?? [] };
}

/**
 * Approves without the third track, with a cut on its way, and reopens: the cancelled approval
 * leaves the third live, published, with no `media_tracks` row.
 */
async function leaveThirdBehind(media: Media, recordingId: string) {
  await approve(media, recordingId, [
    THREE[0] as (typeof THREE)[number],
    { ...(THREE[1] as (typeof THREE)[number]), endMs: 200_000 },
  ]);
  const reopened = await withVersion(media, recordingId, {
    method: 'POST',
    url: `${urlOf(recordingId)}/edit/reopen`,
  });
  expect(reopened.statusCode, reopened.body).toBe(200);
}

const textOf = async (media: Media, id: string) =>
  (await media.owner('GET', `${urlOf(id)}/transcript`))
    .json<{ segments: { text: string }[] }>()
    .segments.map((segment) => segment.text)
    .join(' ');

const preparationOf = async (media: Media, id: string) =>
  (await media.owner('GET', `${urlOf(id)}/edit`)).json<{
    preparation: unknown;
  }>().preparation;

describe('Approved tracks become items (KBC-068)', () => {
  it('AC-1, FR-1: listeners get nothing until every cut is in, then all of them', async () => {
    const world = await startWorld();
    const { media } = world;
    const recording = await transcribed(world, SPEECH);
    await approve(media, recording.id, THREE);
    expect(await preparationOf(media, recording.id)).toEqual({
      total: 3,
      done: 0,
      failed: 0,
    });
    const first = await leaseCut(media);
    if (!first) throw new Error('no cut queued');
    await finishCut(media, first);
    expect(await preparationOf(media, recording.id)).toEqual({
      total: 3,
      done: 1,
      failed: 0,
    });
    expect((await libraryEntry(media.owner, recording.id))?.tracks).toEqual([]);
    await finishCuts(media);
    expect(await preparationOf(media, recording.id)).toBeNull();
    const entry = await libraryEntry(media.owner, recording.id);
    expect(entry?.tracks.map((one) => one.title)).toEqual([
      'Primeira pergunta',
      'Segunda pergunta',
      'Terceira pergunta',
    ]);
    expect(entry?.tracks[1]).toMatchObject({
      durationMs: 180_000,
      topic: recording.topic,
      status: 'ready',
    });
  });

  it('BR-3: records the real times of the cut', async () => {
    const world = await startWorld();
    const { media } = world;
    const recording = await transcribed(world, SPEECH);
    await approve(media, recording.id, THREE);
    await finishCuts(media, 23);
    const entry = await libraryEntry(media.owner, recording.id);
    expect(entry?.tracks[1]?.parent).toMatchObject({
      startMs: 60_000,
      endMs: 240_023,
    });
  });

  it('FR-3: a track reads its slice of the transcript, in its own time', async () => {
    const world = await startWorld();
    const { tracks } = await published(world);
    const [, second] = tracks;
    if (!second) throw new Error('no second track');
    const read = await world.media.owner(
      'GET',
      `${urlOf(second.id)}/transcript`,
    );
    expect(read.statusCode, read.body).toBe(200);
    expect(read.json().segments).toHaveLength(1);
    expect(read.json().segments[0]).toMatchObject({
      startMs: 40_000,
      text: expect.stringContaining('hoasca na segunda faixa'),
    });
    const subtitles = await world.media.owner(
      'GET',
      `${urlOf(second.id)}/subtitles.vtt`,
    );
    expect(subtitles.statusCode).toBe(200);
    expect(subtitles.body).toContain('hoasca');
  });

  it('AC-2, FR-4: a track names its recording, its place and its bounds', async () => {
    const world = await startWorld();
    const { recording, tracks } = await published(world);
    const third = tracks[2];
    if (!third) throw new Error('no third track');
    const read = await world.media.owner('GET', urlOf(third.id));
    expect(read.json<MediaItem>().parent).toEqual({
      id: recording.id,
      title: recording.title,
      startMs: 300_000,
      endMs: 360_000,
      ordinal: 3,
      total: 3,
      version: 0,
      fileVersion: 1,
    });
    expect(
      (await world.media.owner('GET', urlOf(recording.id))).json(),
    ).toMatchObject({
      parent: null,
      archived: false,
    });
  });

  it('BR-1: the full recording stays playable beside its tracks', async () => {
    const world = await startWorld();
    const { recording } = await published(world);
    const stream = await world.media.owner(
      'GET',
      `${urlOf(recording.id)}/stream`,
    );
    expect(stream.statusCode).toBe(200);
  });

  it('AC-3, FR-5: without media-tracks the recording stands alone and a track does not exist', async () => {
    const world = await startWorld();
    const { media } = world;
    const { recording, tracks } = await published(world);
    const person = await member(media, {
      email: 'ouve@example.com',
      topics: ['hermetismo'],
      features: ['media', 'media-library'],
    });
    const entry = await libraryEntry(person.call, recording.id);
    expect(entry?.tracks).toEqual([]);
    const id = tracks[0]?.id ?? '';
    expect((await person.call('GET', urlOf(id))).statusCode).toBe(404);
    expect((await person.call('GET', `${urlOf(id)}/stream`)).statusCode).toBe(
      404,
    );
    expect(
      (await person.call('GET', `${urlOf(id)}/transcript`)).statusCode,
    ).toBe(404);
  });

  it('keeps tracks out of the collection list and in the library sums once', async () => {
    const world = await startWorld();
    const { recording } = await published(world);
    const list = await world.media.owner(
      'GET',
      `/api/v1/topics/${recording.topic}/media`,
    );
    expect(list.json().items.map((item: MediaItem) => item.id)).toEqual([
      recording.id,
    ]);
    const page = await world.media.owner('GET', '/api/v1/media/library');
    expect(page.json().total).toBe(1);
    const found = await world.media.owner(
      'GET',
      '/api/v1/media/library?q=terceira',
    );
    expect(found.json().items).toHaveLength(1);
  });

  it('BR-3 home: a track being heard is in "Continuar ouvindo" with its own title', async () => {
    const world = await startWorld();
    const { tracks } = await published(world);
    const id = tracks[0]?.id ?? '';
    const saved = await world.media.owner('PUT', `${urlOf(id)}/progress`, {
      positionMs: 10_000,
      basedOn: null,
    });
    expect(saved.statusCode, saved.body).toBe(200);
    const home = await world.media.owner('GET', '/api/v1/media/library/home');
    expect(home.json().continueListening[0]).toMatchObject({
      id,
      title: 'Primeira pergunta',
      parent: { ordinal: 1, total: 3 },
    });
  });
});

describe('Approving again (KBC-068 BR-5)', () => {
  it('AC-4: a track ending 20 s earlier keeps its id, position and bookmarks', async () => {
    const world = await startWorld();
    const { media } = world;
    const { recording, tracks } = await published(world);
    const second = tracks[1];
    if (!second) throw new Error('no second track');
    await media.owner('PUT', `${urlOf(second.id)}/progress`, {
      positionMs: 130_000,
      basedOn: null,
    });
    const bookmark = randomUUID();
    const marked = await media.owner('POST', `${urlOf(second.id)}/bookmarks`, {
      id: bookmark,
      positionMs: 20_000,
    });
    expect(marked.statusCode, marked.body).toBe(201);
    const shorter = THREE.map((one, index) =>
      index === 1 ? { ...one, endMs: 220_000 } : one,
    );
    await approve(media, recording.id, shorter);
    expect(await finishCuts(media)).toBe(1);
    const after = (
      await media.owner('GET', urlOf(second.id))
    ).json<MediaItem>();
    expect(after).toMatchObject({
      id: second.id,
      durationMs: 160_000,
      positionMs: 130_000,
      archived: false,
    });
    const marks = await media.owner('GET', `${urlOf(second.id)}/bookmarks`);
    expect(marks.json().items[0]).toMatchObject({
      id: bookmark,
      positionMs: 20_000,
    });
  });

  it('remaps through the absolute time when the start moves', async () => {
    const world = await startWorld();
    const { media } = world;
    const { recording, tracks } = await published(world);
    const second = tracks[1];
    if (!second) throw new Error('no second track');
    await media.owner('PUT', `${urlOf(second.id)}/progress`, {
      positionMs: 50_000,
      basedOn: null,
    });
    const outside = randomUUID();
    await media.owner('POST', `${urlOf(second.id)}/bookmarks`, {
      id: outside,
      positionMs: 5_000,
    });
    const moved = [
      THREE[0],
      { ...THREE[1], startMs: 80_000 },
      THREE[2],
    ] as typeof THREE;
    await approve(media, recording.id, moved);
    await finishCuts(media);
    const after = (
      await media.owner('GET', urlOf(second.id))
    ).json<MediaItem>();
    expect(after.positionMs).toBe(30_000);
    const parent = await media.owner('GET', `${urlOf(recording.id)}/bookmarks`);
    expect(parent.json().items[0]).toMatchObject({
      id: outside,
      positionMs: 65_000,
    });
  });

  it('marks as heard a position past the new end', async () => {
    const world = await startWorld();
    const { media } = world;
    const { recording, tracks } = await published(world);
    const second = tracks[1];
    if (!second) throw new Error('no second track');
    await media.owner('PUT', `${urlOf(second.id)}/progress`, {
      positionMs: 175_000,
      basedOn: null,
    });
    const shorter = [
      THREE[0],
      { ...THREE[1], endMs: 195_000 },
      THREE[2],
    ] as typeof THREE;
    await approve(media, recording.id, shorter);
    await finishCuts(media);
    const after = (
      await media.owner('GET', urlOf(second.id))
    ).json<MediaItem>();
    expect(after.positionMs).toBe(0);
    expect(after.completedAt).not.toBeNull();
  });

  it('a new title alone cuts nothing and publishes at once', async () => {
    const world = await startWorld();
    const { media } = world;
    const { recording, tracks } = await published(world);
    await approve(media, recording.id, [
      { ...(THREE[0] as (typeof THREE)[number]), title: 'Novo título' },
      THREE[1] as (typeof THREE)[number],
      THREE[2] as (typeof THREE)[number],
    ]);
    expect(await leaseCut(media)).toBeNull();
    const entry = await libraryEntry(media.owner, recording.id);
    expect(entry?.tracks[0]).toMatchObject({
      id: tracks[0]?.id,
      title: 'Novo título',
    });
  });

  it('AC-5: a track that leaves is archived: gone from the library and search, its page says so', async () => {
    const world = await startWorld();
    const { media } = world;
    const { recording, tracks } = await published(world);
    const third = tracks[2];
    if (!third) throw new Error('no third track');
    await approve(media, recording.id, THREE.slice(0, 2));
    expect(await finishCuts(media)).toBe(0);
    const entry = await libraryEntry(media.owner, recording.id);
    expect(entry?.tracks.map((one) => one.id)).toEqual(
      tracks.slice(0, 2).map((one) => one.id),
    );
    const read = await media.owner('GET', urlOf(third.id));
    expect(read.json<MediaItem>()).toMatchObject({
      archived: true,
      parent: { ordinal: null, total: 2 },
    });
    expect(
      (await media.owner('GET', `${urlOf(third.id)}/stream`)).statusCode,
    ).toBe(404);
    const search = await media.owner(
      'POST',
      '/api/v1/topics/hermetismo/searches',
      {
        q: 'mariri',
      },
    );
    expect(
      search.json().media.map((hit: { mediaId: string }) => hit.mediaId),
    ).toEqual([recording.id]);
  });

  it('keeps what is published while the new cuts are on their way', async () => {
    const world = await startWorld();
    const { media } = world;
    const { recording, tracks } = await published(world);
    await approve(media, recording.id, [
      { ...(THREE[0] as (typeof THREE)[number]), endMs: 50_000 },
      THREE[1] as (typeof THREE)[number],
    ]);
    const entry = await libraryEntry(media.owner, recording.id);
    expect(entry?.tracks.map((one) => one.id)).toEqual(
      tracks.map((one) => one.id),
    );
    await finishCuts(media);
    expect(
      (await libraryEntry(media.owner, recording.id))?.tracks,
    ).toHaveLength(2);
  });

  it('reopening stops the cuts and leaves no file behind', async () => {
    const world = await startWorld();
    const { media } = world;
    const recording = await transcribed(world, SPEECH);
    await approve(media, recording.id, THREE);
    const first = await leaseCut(media);
    if (!first) throw new Error('no cut queued');
    await finishCut(media, first);
    const late = await leaseCut(media);
    if (!late) throw new Error('no second cut');
    const reopened = await withVersion(media, recording.id, {
      method: 'POST',
      url: `${urlOf(recording.id)}/edit/reopen`,
    });
    expect(reopened.statusCode, reopened.body).toBe(200);
    expect(await leaseCut(media)).toBeNull();
    expect((await libraryEntry(media.owner, recording.id))?.tracks).toEqual([]);
    const names = readdirSync(join(media.mediaDir, 'audio'));
    expect(names.filter((name) => name.endsWith('.m4a'))).toEqual([
      `${recording.id}.m4a`,
    ]);
    await expect(finishCut(media, late)).rejects.toThrow();
  });

  it('a cut given up can be tried again', async () => {
    const world = await startWorld();
    const { media } = world;
    const recording = await transcribed(world, SPEECH);
    await approve(media, recording.id, THREE.slice(0, 1));
    const job = await leaseCut(media);
    if (!job) throw new Error('no cut queued');
    const failed = await media.started.app.inject({
      method: 'POST',
      url: `/api/v1/media-worker/jobs/${job.id}/fail`,
      headers: (await import('../test/media-harness.js')).WORKER,
      payload: {
        worker: 'vm',
        leaseId: job.leaseId,
        failure: 'invalid-audio',
        detail: 'no packets',
      },
    });
    expect(failed.statusCode, failed.body).toBe(204);
    expect(await preparationOf(media, recording.id)).toEqual({
      total: 1,
      done: 0,
      failed: 1,
    });
    const retried = await withVersion(media, recording.id, {
      method: 'POST',
      url: `${urlOf(recording.id)}/edit/retry-cuts`,
      payload: {},
    });
    expect(retried.statusCode, retried.body).toBe(200);
    expect(await finishCuts(media)).toBe(1);
    expect(await preparationOf(media, recording.id)).toBeNull();
  });

  it('keeps the replaced file for who is on it (KBC-073 BR-3)', async () => {
    const world = await startWorld();
    const { media } = world;
    const { recording, tracks } = await published(world);
    const id = tracks[0]?.id ?? '';
    const before = readdirSync(join(media.mediaDir, 'audio')).filter((name) =>
      name.startsWith(id),
    );
    await approve(media, recording.id, [
      { ...(THREE[0] as (typeof THREE)[number]), endMs: 50_000 },
      THREE[1] as (typeof THREE)[number],
      THREE[2] as (typeof THREE)[number],
    ]);
    await finishCuts(media);
    const after = readdirSync(join(media.mediaDir, 'audio')).filter((name) =>
      name.startsWith(id),
    );
    expect(after).toHaveLength(2);
    expect(after).toEqual(expect.arrayContaining(before));
  });
});

describe('A track follows its recording (KBC-068)', () => {
  it('AC-7, BR-2: moved with it: 404 for who cannot see the new collection', async () => {
    const world = await startWorld();
    const { media } = world;
    const { recording, tracks } = await published(world);
    const person = await member(media, {
      email: 'ouve@example.com',
      topics: ['hermetismo'],
      features: LISTENER,
    });
    const id = tracks[0]?.id ?? '';
    expect((await person.call('GET', urlOf(id))).statusCode).toBe(200);
    const moved = await media.owner('PATCH', urlOf(recording.id), {
      topic: 'udv',
      author: null,
    });
    expect(moved.statusCode, moved.body).toBe(200);
    expect((await person.call('GET', urlOf(id))).statusCode).toBe(404);
    expect((await person.call('GET', `${urlOf(id)}/stream`)).statusCode).toBe(
      404,
    );
    expect((await media.owner('GET', urlOf(id))).json()).toMatchObject({
      topic: 'udv',
    });
  });

  it('AC-8, BR-4: a new transcript of the recording updates its tracks and search', async () => {
    const world = await startWorld();
    const { media } = world;
    const { recording, tracks } = await published(world);
    const second = tracks[1]?.id ?? '';
    const queued = await media.owner(
      'POST',
      `${urlOf(recording.id)}/transcription`,
      {},
    );
    expect(queued.statusCode, queued.body).toBeLessThan(300);
    await say(world, [{ at: 100, text: 'palavra nova da faixa' }]);
    const read = await media.owner('GET', `${urlOf(second)}/transcript`);
    expect(read.json().segments[0].text).toContain('palavra nova');
    const search = await media.owner(
      'POST',
      '/api/v1/topics/hermetismo/searches',
      {
        q: 'hoasca',
      },
    );
    expect(search.json().media).toEqual([]);
  });

  it('AC-8, BR-4: a live track a cancelled approval left behind gets the new transcript too', async () => {
    const world = await startWorld();
    const { media } = world;
    const { recording, tracks } = await published(world);
    await leaveThirdBehind(media, recording.id);
    const queued = await media.owner(
      'POST',
      `${urlOf(recording.id)}/transcription`,
      {},
    );
    expect(queued.statusCode, queued.body).toBeLessThan(300);
    await say(world, [{ at: 310, text: 'ayahuasca na faixa deixada' }]);
    const third = tracks[2]?.id ?? '';
    expect(await textOf(media, third)).toContain('ayahuasca');
    const search = await media.owner(
      'POST',
      '/api/v1/topics/hermetismo/searches',
      { q: 'ayahuasca' },
    );
    expect(search.json().media).toHaveLength(1);
    expect(search.json().media[0]).toMatchObject({
      mediaId: third,
      startMs: 10_000,
    });
  });

  it('BR-4: approving the same bounds again brings a track left on an old version up to date', async () => {
    const world = await startWorld();
    const { media } = world;
    const { recording, tracks } = await published(world);
    await leaveThirdBehind(media, recording.id);
    const db = new DatabaseSync(join(media.mediaDir, 'media.db'));
    const third = tracks[2]?.id ?? '';
    const first = tracks[0]?.id ?? '';
    db.prepare(
      `UPDATE segments SET text = 'texto antigo' WHERE transcript_id IN
         (SELECT id FROM transcripts WHERE media_id = ?)`,
    ).run(third);
    db.prepare(`UPDATE transcripts SET model = 'older' WHERE media_id = ?`).run(
      third,
    );
    const versionOfFirst = () =>
      db.prepare(`SELECT id FROM transcripts WHERE media_id = ?`).get(first);
    const before = versionOfFirst();
    await approve(media, recording.id, THREE);
    expect(await finishCuts(media)).toBe(0);
    expect(await textOf(media, third)).toContain('mariri');
    expect(versionOfFirst()).toEqual(before);
    db.close();
  });

  it("BR-2: a live track a cancelled approval left behind follows the recording's author", async () => {
    const world = await startWorld();
    const { media } = world;
    const { recording, tracks } = await published(world);
    await leaveThirdBehind(media, recording.id);
    await media.owner('POST', '/api/v1/topics/udv/authors', {
      name: 'Autor Novo',
    });
    const moved = await media.owner('PATCH', urlOf(recording.id), {
      topic: 'udv',
      author: 'autor-novo',
    });
    expect(moved.statusCode, moved.body).toBe(200);
    const third = await media.owner('GET', urlOf(tracks[2]?.id ?? ''));
    expect(third.json().topic).toBe('udv');
    expect(third.json().author?.slug).toBe('autor-novo');
  });

  it('AC-1: the track is by who answers when they are an author, else by the recording', async () => {
    const world = await startWorld();
    const { media } = world;
    const recording = await transcribed(world, SPEECH);
    await media.owner('POST', '/api/v1/topics/hermetismo/authors', {
      name: 'Quem Responde',
    });
    const author = await media.owner(
      'POST',
      '/api/v1/topics/hermetismo/speakers',
      { name: 'Quem Responde', authorSlug: 'quem-responde' },
    );
    expect(author.statusCode, author.body).toBeLessThan(300);
    const stranger = await media.owner(
      'POST',
      '/api/v1/topics/hermetismo/speakers',
      { name: 'Alguém da plateia' },
    );
    await approve(media, recording.id, [
      {
        startMs: 0,
        endMs: 60_000,
        answererSpeakerId: author.json().id,
      },
      {
        startMs: 60_000,
        endMs: 120_000,
        answererSpeakerId: stranger.json().id,
      },
    ]);
    await finishCuts(media);
    const entry = await libraryEntry(media.owner, recording.id);
    expect(entry?.tracks[0]?.author?.slug).toBe('quem-responde');
    expect(entry?.tracks[1]?.author?.slug).toBe(
      (await media.owner('GET', urlOf(recording.id))).json().author?.slug,
    );
  });

  it('AC-1: a voice no separation names leaves the track by the recording', async () => {
    const world = await startWorld();
    const { media } = world;
    const recording = await transcribed(world, SPEECH);
    await approve(media, recording.id, [
      { startMs: 0, endMs: 60_000, answererVoice: 2 },
    ]);
    await finishCuts(media);
    const entry = await libraryEntry(media.owner, recording.id);
    expect(entry?.tracks[0]?.author?.slug).toBe(
      (await media.owner('GET', urlOf(recording.id))).json().author?.slug,
    );
  });

  it('BR-2: a recording moved while its first cuts are on their way publishes them by the new author', async () => {
    const world = await startWorld();
    const { media } = world;
    const recording = await transcribed(world, SPEECH);
    await approve(media, recording.id, THREE);
    await media.owner('POST', '/api/v1/topics/udv/authors', {
      name: 'Autor Novo',
    });
    const moved = await media.owner('PATCH', urlOf(recording.id), {
      topic: 'udv',
      author: 'autor-novo',
    });
    expect(moved.statusCode, moved.body).toBe(200);
    expect(await finishCuts(media)).toBe(3);
    const entry = await libraryEntry(media.owner, recording.id);
    expect(entry?.tracks.map((one) => one.author?.slug)).toEqual([
      'autor-novo',
      'autor-novo',
      'autor-novo',
    ]);
  });

  it('refuses on a track what only a recording does', async () => {
    const world = await startWorld();
    const { media } = world;
    const { tracks } = await published(world);
    const id = tracks[0]?.id ?? '';
    const url = urlOf(id);
    expect((await media.owner('GET', `${url}/edit`)).statusCode).toBe(409);
    expect(
      (await media.owner('POST', `${url}/transcription`, {})).statusCode,
    ).toBe(409);
    expect((await media.owner('POST', `${url}/diarize`, {})).statusCode).toBe(
      409,
    );
  });

  it('a recording with tracks is removed only with them, by name, and leaves no file', async () => {
    const world = await startWorld();
    const { media } = world;
    const { recording, tracks } = await published(world);
    const refused = await media.owner('DELETE', urlOf(recording.id));
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error.details).toMatchObject({
      reason: 'has-tracks',
      tracks: ['Primeira pergunta', 'Segunda pergunta', 'Terceira pergunta'],
    });
    const gone = await media.owner(
      'DELETE',
      `${urlOf(recording.id)}?cascade=true`,
    );
    expect(gone.statusCode, gone.body).toBe(204);
    expect(
      (await media.owner('GET', urlOf(tracks[0]?.id ?? ''))).statusCode,
    ).toBe(404);
    const left = readdirSync(join(media.mediaDir, 'audio'));
    expect(left.filter((name) => name.endsWith('.m4a'))).toEqual([]);
    expect(
      existsSync(join(media.mediaDir, 'transcripts', tracks[0]?.id ?? '')),
    ).toBe(false);
  });

  it('reads the pauses of a track from its recording, in its own time', async () => {
    const world = await startWorld();
    const { media } = world;
    const { tracks } = await published(world);
    const read = await media.owner(
      'GET',
      `${urlOf(tracks[0]?.id ?? '')}/silences`,
    );
    expect(read.statusCode, read.body).toBe(200);
    expect(read.json().status).toBe('pending');
  });
});

describe('Searching a track (KBC-068 BR-6)', () => {
  it('AC-6: a word inside a track answers as the track, in its time, once; without media-tracks, as the recording', async () => {
    const world = await startWorld();
    const { media } = world;
    const { recording, tracks } = await published(world);
    const person = await member(media, {
      email: 'ouve@example.com',
      topics: ['hermetismo'],
      features: ['media', 'search'],
    });
    const url = '/api/v1/topics/hermetismo/searches';
    const withTracks = await media.owner('POST', url, { q: 'hoasca' });
    expect(withTracks.json().media).toHaveLength(1);
    expect(withTracks.json().media[0]).toMatchObject({
      mediaId: tracks[1]?.id,
      title: 'Segunda pergunta',
      startMs: 40_000,
    });
    const alone = await person.call('POST', url, { q: 'hoasca' });
    expect(alone.json().media).toHaveLength(1);
    expect(alone.json().media[0]).toMatchObject({
      mediaId: recording.id,
      startMs: 100_000,
    });
    const outside = await media.owner('POST', url, { q: 'intervalo' });
    expect(outside.json().media[0]).toMatchObject({ mediaId: recording.id });
  });

  it('BR-6: a word in the gap after a track, in a segment past its end, stays with the recording', async () => {
    const world = await startWorld();
    const { media } = world;
    const recording = await transcribed(world, [
      {
        at: 100,
        text: 'dentro dentro dentro dentro dentro dentro ultimapalavra final',
      },
    ]);
    await approve(media, recording.id, [{ startMs: 60_000, endMs: 102_500 }]);
    await finishCuts(media);
    const found = await media.owner(
      'POST',
      '/api/v1/topics/hermetismo/searches',
      { q: 'ultimapalavra' },
    );
    expect(found.json().media).toHaveLength(1);
    expect(found.json().media[0]).toMatchObject({
      mediaId: recording.id,
      startMs: 100_000,
    });
  });

  it('BR-6: a segment split between two tracks answers only as the tracks', async () => {
    const world = await startWorld();
    const { media } = world;
    const recording = await transcribed(world, [
      { at: 100, text: 'uma duas tres quatro cinco seis sete oitava' },
    ]);
    await approve(media, recording.id, [
      { startMs: 60_000, endMs: 102_000, title: 'Antes' },
      { startMs: 102_000, endMs: 120_000, title: 'Depois' },
    ]);
    await finishCuts(media);
    const found = await media.owner(
      'POST',
      '/api/v1/topics/hermetismo/searches',
      { q: 'oitava' },
    );
    expect(found.json().media).toHaveLength(1);
    expect(found.json().media[0]).toMatchObject({ title: 'Depois' });
  });

  it('AC-7: nothing of a moved recording reaches who cannot see its collection', async () => {
    const world = await startWorld();
    const { media } = world;
    const { recording } = await published(world);
    const person = await member(media, {
      email: 'ouve@example.com',
      topics: ['hermetismo'],
      features: LISTENER,
    });
    await media.owner('PATCH', urlOf(recording.id), {
      topic: 'udv',
      author: null,
    });
    const found = await person.call(
      'POST',
      '/api/v1/topics/hermetismo/searches',
      {
        q: 'hoasca',
      },
    );
    expect(found.json().media).toEqual([]);
  });
});
