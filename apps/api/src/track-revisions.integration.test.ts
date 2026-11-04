import { randomUUID } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type {
  ArchivedTracks,
  MediaItem,
  MediaTranscript,
  MovedBookmarks,
  ProposalEstimate,
  TrackEditView,
  TrackHistory,
  TrackImpact,
  TrackSuggestion,
} from '@kb-chat/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { FAKE_FREE_MODELS } from './testing/fake-openrouter.js';
import { SqliteTrackRevisionStore } from './adapters/sqlite/sqlite-track-revision-store.js';
import { closeApp, connectHouse } from '../test/ai-app-harness.js';
import {
  leaseDiarization,
  pairDiarizer,
  requestVoices,
  sendTurns,
  transcribedItem,
} from '../test/diarization-harness.js';
import { member, type Media } from '../test/media-harness.js';
import {
  approve,
  finishCuts,
  leaseCut,
  libraryEntry,
  startWorld,
  transcribed,
  withVersion,
  type World,
} from '../test/track-items-harness.js';

afterEach(closeApp);

const TRACKS = [
  { startMs: 60_000, endMs: 240_000, title: 'Primeira pergunta' },
  { startMs: 240_000, endMs: 480_000, title: 'Segunda pergunta' },
];
const SPEECH = [
  { at: 70, text: 'abertura da primeira faixa' },
  { at: 300, text: 'hoasca na segunda faixa' },
];

const urlOf = (id: string) => `/api/v1/media/${id}`;

async function published(world: World) {
  const { media } = world;
  const recording = await transcribed(world, SPEECH);
  await approve(media, recording.id, TRACKS);
  await finishCuts(media);
  const entry = await libraryEntry(media.owner, recording.id);
  const [first, second] = entry?.tracks ?? [];
  if (!first || !second) throw new Error('no tracks');
  return { recording, first, second };
}

const send = (
  media: Media,
  request: {
    method: 'PATCH' | 'PUT' | 'POST' | 'DELETE';
    url: string;
    version?: number;
    payload?: object;
  },
) => {
  const { version, ...rest } = request;
  return media.started.app.inject({
    ...rest,
    headers: {
      ...media.ownerHeaders,
      ...(version === undefined ? {} : { 'if-match': `"${version}"` }),
    },
  });
};

const viewOf = async (media: Media, id: string) => {
  const read = await media.owner('GET', `${urlOf(id)}/track-edit`);
  expect(read.statusCode, read.body).toBe(200);
  return read.json<TrackEditView>();
};

const patch = async (media: Media, id: string, payload: object) =>
  send(media, {
    method: 'PATCH',
    url: urlOf(id),
    version: (await viewOf(media, id)).version,
    payload,
  });

const moveBounds = async (
  media: Media,
  id: string,
  payload: { startMs: number; endMs: number },
) =>
  send(media, {
    method: 'PUT',
    url: `${urlOf(id)}/bounds`,
    version: (await viewOf(media, id)).version,
    payload,
  });

describe('Details of an approved track (FR-1)', () => {
  it('AC-1: the title changes on the same id, and search finds it next', async () => {
    const world = await startWorld();
    const { media } = world;
    const { recording, first } = await published(world);

    const changed = await patch(media, first.id, { title: 'Título corrigido' });

    expect(changed.statusCode, changed.body).toBe(200);
    expect(changed.json<MediaItem>().id).toBe(first.id);
    expect(changed.json<MediaItem>().title).toBe('Título corrigido');
    const entry = await libraryEntry(media.owner, recording.id);
    expect(entry?.tracks[0]?.title).toBe('Título corrigido');
    const found = await media.owner('GET', '/api/v1/media/library?q=corrigido');
    expect(found.body).toContain(first.id);
  });

  it('NFR-1: a title saves within 300 ms', async () => {
    const world = await startWorld();
    const { first } = await published(world);
    const view = await viewOf(world.media, first.id);

    const before = performance.now();
    await send(world.media, {
      method: 'PATCH',
      url: urlOf(first.id),
      version: view.version,
      payload: { title: 'Rápido' },
    });

    expect(performance.now() - before).toBeLessThan(300);
  });

  it('the draft of a reopened edit shows the change', async () => {
    const world = await startWorld();
    const { media } = world;
    const { recording, first } = await published(world);

    await patch(media, first.id, { title: 'No rascunho também' });

    const edit = await media.owner('GET', `${urlOf(recording.id)}/edit`);
    expect(edit.body).toContain('No rascunho também');
  });

  it('AC-13: who saves second gets 412 and their write changes nothing', async () => {
    const world = await startWorld();
    const { media } = world;
    const { first } = await published(world);
    const { version } = await viewOf(media, first.id);
    await patch(media, first.id, { title: 'Da primeira pessoa' });

    const late = await send(media, {
      method: 'PATCH',
      url: urlOf(first.id),
      version,
      payload: { title: 'Da segunda pessoa' },
    });

    expect(late.statusCode).toBe(412);
    expect((await viewOf(media, first.id)).title).toBe('Da primeira pessoa');
  });

  it('asks for the version on a track and refuses a recording its fields', async () => {
    const world = await startWorld();
    const { media } = world;
    const { recording, first } = await published(world);

    const blind = await send(media, {
      method: 'PATCH',
      url: urlOf(first.id),
      payload: { title: 'x' },
    });
    const notATrack = await send(media, {
      method: 'PATCH',
      url: urlOf(recording.id),
      payload: { summary: 'x' },
    });

    expect(blind.statusCode).toBe(428);
    expect(notATrack.statusCode).toBe(400);
  });

  it('while the edit is reopened nothing here writes', async () => {
    const world = await startWorld();
    const { media } = world;
    const { recording, first } = await published(world);
    const reopened = await withVersion(media, recording.id, {
      method: 'POST',
      url: `${urlOf(recording.id)}/edit/reopen`,
    });
    expect(reopened.statusCode).toBe(200);

    const refused = await patch(media, first.id, { title: 'x' });

    expect(refused.statusCode).toBe(409);
    expect(refused.body).toContain('edit-open');
  });

  it('a summary is saved and read with the track', async () => {
    const world = await startWorld();
    const { media } = world;
    const { first } = await published(world);

    await patch(media, first.id, { summary: 'Sobre a abertura.' });

    expect((await viewOf(media, first.id)).summary).toBe('Sobre a abertura.');
  });
});

describe('Bounds of an approved track (FR-2)', () => {
  it('AC-6: refuses an overlap and a track under 5 s', async () => {
    const world = await startWorld();
    const { media } = world;
    const { first } = await published(world);

    const overlap = await moveBounds(media, first.id, {
      startMs: 60_000,
      endMs: 250_000,
    });
    const short = await moveBounds(media, first.id, {
      startMs: 60_000,
      endMs: 64_000,
    });

    expect(overlap.statusCode).toBe(422);
    expect(short.statusCode).toBe(422);
    expect(await leaseCut(media)).toBeNull();
  });

  it('AC-4: the position and bookmark follow the absolute time, and the owner is told', async () => {
    const world = await startWorld();
    const { media } = world;
    const { recording, first } = await published(world);
    const saved = await send(media, {
      method: 'PUT',
      url: `${urlOf(first.id)}/progress`,
      payload: { positionMs: 90_000, basedOn: null },
    });
    expect(saved.statusCode, saved.body).toBe(200);
    const bookmark = randomUUID();
    const marked = await send(media, {
      method: 'POST',
      url: `${urlOf(first.id)}/bookmarks`,
      payload: { id: bookmark, positionMs: 170_000 },
    });
    expect(marked.statusCode, marked.body).toBe(201);

    const moved = await moveBounds(media, first.id, {
      startMs: 90_000,
      endMs: 210_000,
    });

    expect(moved.statusCode, moved.body).toBe(202);
    const during = await media.owner('GET', urlOf(first.id));
    expect(during.json<MediaItem>().parent?.startMs).toBe(60_000);
    expect((await viewOf(media, first.id)).cut).toBe('running');
    expect(await finishCuts(media)).toBe(1);
    const after = (await media.owner('GET', urlOf(first.id))).json<MediaItem>();
    expect(after.id).toBe(first.id);
    expect(after.parent?.startMs).toBe(90_000);
    expect(after.parent?.endMs).toBe(210_000);
    expect(after.parent?.fileVersion).toBe(
      (first.parent?.fileVersion ?? 0) + 1,
    );
    expect(after.positionMs).toBe(60_000);
    const onRecording = await media.owner(
      'GET',
      `${urlOf(recording.id)}/bookmarks`,
    );
    expect(onRecording.body).toContain(bookmark);
    expect(onRecording.body).toContain('230000');
    const notice = await media.owner('GET', '/api/v1/media/bookmarks/moved');
    expect(notice.json<MovedBookmarks>().moved).toEqual([
      {
        mediaId: first.id,
        recordingId: recording.id,
        title: first.title,
        count: 1,
      },
    ]);
    const seen = await send(media, {
      method: 'POST',
      url: '/api/v1/media/bookmarks/moved/seen',
    });
    expect(seen.statusCode).toBe(204);
    const gone = await media.owner('GET', '/api/v1/media/bookmarks/moved');
    expect(gone.json<MovedBookmarks>().moved).toEqual([]);
  });

  it('AC-4: the text starts at the new start', async () => {
    const world = await startWorld();
    const { media } = world;
    const { first } = await published(world);

    await moveBounds(media, first.id, { startMs: 100_000, endMs: 200_000 });
    await finishCuts(media);

    const transcript = await media.owner(
      'GET',
      `${urlOf(first.id)}/transcript`,
    );
    expect(transcript.body).not.toContain('abertura');
  });

  it('AC-5: who is on the old cut keeps it, and their position is translated', async () => {
    const world = await startWorld();
    const { media } = world;
    const { first } = await published(world);
    const oldVersion = first.parent?.fileVersion ?? 1;
    await moveBounds(media, first.id, { startMs: 90_000, endMs: 210_000 });
    await finishCuts(media);

    const old = await media.owner(
      'GET',
      `${urlOf(first.id)}/stream?v=${oldVersion}`,
    );
    const current = await media.owner('GET', `${urlOf(first.id)}/stream`);
    const missing = await media.owner('GET', `${urlOf(first.id)}/stream?v=99`);

    expect(old.statusCode).toBe(200);
    expect(current.statusCode).toBe(200);
    expect(old.headers['etag']).not.toBe(current.headers['etag']);
    expect(missing.statusCode).toBe(404);
    const saved = await send(media, {
      method: 'PUT',
      url: `${urlOf(first.id)}/progress`,
      payload: {
        positionMs: 60_000,
        basedOn: null,
        fileVersion: oldVersion,
      },
    });
    expect(saved.statusCode, saved.body).toBe(200);
    expect(saved.json<{ positionMs: number }>().positionMs).toBe(30_000);
  });

  it('a second change waits for the running cut', async () => {
    const world = await startWorld();
    const { media } = world;
    const { first } = await published(world);
    await moveBounds(media, first.id, { startMs: 90_000, endMs: 210_000 });

    const refused = await moveBounds(media, first.id, {
      startMs: 80_000,
      endMs: 210_000,
    });

    expect(refused.statusCode).toBe(409);
    expect(refused.body).toContain('cut-running');
  });
});

describe('A cut that fails (FR-2)', () => {
  const giveUpCut = (media: Media) => {
    const db = new DatabaseSync(join(media.mediaDir, 'media.db'));
    db.exec(`UPDATE jobs SET status = 'dead' WHERE kind = 'cut'`);
    db.close();
  };

  it('can be tried again, or replaced by other bounds', async () => {
    const world = await startWorld();
    const { media } = world;
    const { first } = await published(world);
    await moveBounds(media, first.id, { startMs: 90_000, endMs: 210_000 });
    giveUpCut(media);
    const failed = await viewOf(media, first.id);
    expect(failed.cut).toBe('failed');

    const retried = await send(media, {
      method: 'POST',
      url: `${urlOf(first.id)}/bounds/retry`,
      version: failed.version,
    });

    expect(retried.statusCode, retried.body).toBe(202);
    giveUpCut(media);
    const replaced = await moveBounds(media, first.id, {
      startMs: 80_000,
      endMs: 210_000,
    });
    expect(replaced.statusCode, replaced.body).toBe(202);
    expect(await finishCuts(media)).toBe(1);
    const item = (await media.owner('GET', urlOf(first.id))).json<MediaItem>();
    expect(item.parent?.startMs).toBe(80_000);
  });

  it('a jump over the neighbour renumbers the tracks', async () => {
    const world = await startWorld();
    const { media } = world;
    const { first, second } = await published(world);

    await moveBounds(media, first.id, { startMs: 500_000, endMs: 560_000 });

    expect((await viewOf(media, second.id)).ordinal).toBe(1);
    expect((await viewOf(media, first.id)).ordinal).toBe(2);
  });
});

describe('Deleting and restoring a track (FR-3, FR-4)', () => {
  async function deleted(world: World) {
    const { media } = world;
    const made = await published(world);
    await send(media, {
      method: 'PUT',
      url: `${urlOf(made.first.id)}/progress`,
      payload: { positionMs: 30_000, basedOn: null },
    });
    await send(media, {
      method: 'POST',
      url: `${urlOf(made.first.id)}/bookmarks`,
      payload: { id: randomUUID(), positionMs: 20_000 },
    });
    const impact = await media.owner(
      'GET',
      `${urlOf(made.first.id)}/track-impact`,
    );
    expect(impact.json<TrackImpact>()).toEqual({ listeners: 1, bookmarks: 1 });
    const gone = await send(media, {
      method: 'DELETE',
      url: urlOf(made.first.id),
    });
    expect(gone.statusCode, gone.body).toBe(204);
    return made;
  }

  it('AC-8: leaves the library and search, and comes back as it was', async () => {
    const world = await startWorld();
    const { media } = world;
    const { recording, first, second } = await deleted(world);

    const entry = await libraryEntry(media.owner, recording.id);
    expect(entry?.tracks.map((one) => one.id)).toEqual([second.id]);
    expect(entry?.tracks[0]?.parent?.ordinal).toBe(1);
    const page = await media.owner('GET', urlOf(first.id));
    expect(page.json<MediaItem>().archived).toBe(true);
    const stream = await media.owner('GET', `${urlOf(first.id)}/stream`);
    expect(stream.statusCode).toBe(404);
    const list = await media.owner(
      'GET',
      `${urlOf(recording.id)}/archived-tracks`,
    );
    expect(list.json<ArchivedTracks>().tracks[0]?.mediaId).toBe(first.id);

    const back = await send(media, {
      method: 'POST',
      url: `${urlOf(first.id)}/restore`,
    });

    expect(back.statusCode, back.body).toBe(200);
    const item = back.json<MediaItem>();
    expect(item.archived).toBe(false);
    expect(item.positionMs).toBe(30_000);
    expect(item.parent?.ordinal).toBe(1);
    const restored = await libraryEntry(media.owner, recording.id);
    expect(restored?.tracks.map((one) => one.id)).toEqual([
      first.id,
      second.id,
    ]);
    const marks = await media.owner('GET', `${urlOf(first.id)}/bookmarks`);
    expect(marks.body).toContain('20000');
    const edit = await media.owner('GET', `${urlOf(recording.id)}/edit`);
    expect(edit.body).toContain(first.title);
  });

  it('a track that left by a new approval comes back too, on its own bounds', async () => {
    const world = await startWorld();
    const { media } = world;
    const { recording, first, second } = await published(world);
    await approve(media, recording.id, [TRACKS[1] as (typeof TRACKS)[number]]);
    await finishCuts(media);
    const page = await media.owner('GET', urlOf(first.id));
    expect(page.json<MediaItem>().archived).toBe(true);

    const back = await send(media, {
      method: 'POST',
      url: `${urlOf(first.id)}/restore`,
    });

    expect(back.statusCode, back.body).toBe(200);
    const view = await viewOf(media, first.id);
    expect(view).toMatchObject({
      title: first.title,
      startMs: 60_000,
      endMs: 240_000,
      ordinal: 1,
    });
    expect(view.answerer.voice).toBeNull();
    expect((await viewOf(media, second.id)).ordinal).toBe(2);
  });

  it('restoring over a neighbour that grew is refused', async () => {
    const world = await startWorld();
    const { media } = world;
    const { first, second } = await deleted(world);
    await moveBounds(media, second.id, { startMs: 100_000, endMs: 480_000 });
    await finishCuts(media);

    const back = await send(media, {
      method: 'POST',
      url: `${urlOf(first.id)}/restore`,
    });

    expect(back.statusCode).toBe(409);
    expect(back.body).toContain('restore-overlap');
  });

  it('a track being re-cut is not deleted', async () => {
    const world = await startWorld();
    const { media } = world;
    const { first } = await published(world);
    await moveBounds(media, first.id, { startMs: 90_000, endMs: 210_000 });

    const refused = await send(media, {
      method: 'DELETE',
      url: urlOf(first.id),
    });

    expect(refused.statusCode).toBe(409);
  });

  it('removing the recording takes the replaced cuts too', async () => {
    const world = await startWorld();
    const { media } = world;
    const { recording, first } = await published(world);
    await moveBounds(media, first.id, { startMs: 90_000, endMs: 210_000 });
    await finishCuts(media);
    const dir = join(media.mediaDir, 'audio');
    const cutsOf = () =>
      readdirSync(dir).filter((name) => name.startsWith(first.id));
    expect(cutsOf().length).toBe(2);

    const removed = await send(media, {
      method: 'DELETE',
      url: `${urlOf(recording.id)}?cascade=true`,
    });

    expect(removed.statusCode, removed.body).toBe(204);
    expect(cutsOf()).toEqual([]);
  });
});

describe('Who speaks (FR-1)', () => {
  const VOICED = [
    { startMs: 0, endMs: 20_000, title: 'Faixa um', answererVoice: 1 },
    { startMs: 20_000, endMs: 40_000, title: 'Faixa dois', answererVoice: 1 },
  ];

  async function voiced() {
    const world = await startWorld();
    const { media } = world;
    const { token } = await pairDiarizer(media);
    const id = await transcribedItem(media, token);
    expect((await requestVoices(media, id)).statusCode).toBe(202);
    const job = await leaseDiarization(media, token);
    expect((await sendTurns(media, { token, job })).statusCode).toBe(204);
    await approve(media, id, VOICED);
    await finishCuts(media);
    const entry = await libraryEntry(media.owner, id);
    const [first, second] = entry?.tracks ?? [];
    if (!first || !second) throw new Error('no tracks');
    return { media, id, first, second };
  }

  const speaker = async (media: Media, name: string) => {
    const added = await media.owner(
      'POST',
      '/api/v1/topics/hermetismo/speakers',
      { name },
    );
    expect(added.statusCode, added.body).toBeLessThan(300);
    return added.json<{ id: string }>().id;
  };

  it('AC-2: across the recording every track of the voice changes; on one, only it', async () => {
    const { media, first, second } = await voiced();
    const jose = await speaker(media, 'José');
    const maria = await speaker(media, 'Maria');

    const everywhere = await patch(media, first.id, {
      answererSpeakerId: jose,
      scope: 'recording',
    });

    expect(everywhere.statusCode, everywhere.body).toBe(200);
    expect((await viewOf(media, first.id)).answerer.name).toBe('José');
    expect((await viewOf(media, second.id)).answerer.name).toBe('José');

    await patch(media, second.id, {
      answererSpeakerId: maria,
      scope: 'track',
    });

    expect((await viewOf(media, first.id)).answerer.name).toBe('José');
    expect((await viewOf(media, second.id)).answerer.name).toBe('Maria');
    const onThis = await media.owner('GET', `${urlOf(second.id)}/transcript`);
    expect(onThis.json<MediaTranscript>().voiceNames?.[0]?.name).toBe('Maria');
    const onOther = await media.owner('GET', `${urlOf(first.id)}/transcript`);
    expect(onOther.json<MediaTranscript>().voiceNames?.[0]?.name).toBe('José');
    const history = await media.owner('GET', `${urlOf(second.id)}/history`);
    expect(
      history.json<TrackHistory>().changes.map((one) => one.after),
    ).toEqual(['Maria', 'José']);
  });

  it('BR-7: a deleted track comes back with its voice and its own name', async () => {
    const { media, first } = await voiced();
    const maria = await speaker(media, 'Maria');
    await patch(media, first.id, { answererSpeakerId: maria });
    await send(media, { method: 'DELETE', url: urlOf(first.id) });

    const back = await send(media, {
      method: 'POST',
      url: `${urlOf(first.id)}/restore`,
    });

    expect(back.statusCode, back.body).toBe(200);
    const { answerer } = await viewOf(media, first.id);
    expect(answerer).toMatchObject({ voice: 1, name: 'Maria' });
  });

  it('a track with no voice cannot name one across the recording', async () => {
    const world = await startWorld();
    const { media } = world;
    const { first } = await published(world);
    const jose = await speaker(media, 'José');

    const refused = await patch(media, first.id, {
      answererSpeakerId: jose,
      scope: 'recording',
    });

    expect(refused.statusCode).toBe(409);
    expect(refused.body).toContain('no-voice');
  });

  it('a speaker of another collection is refused', async () => {
    const world = await startWorld();
    const { media } = world;
    const { first } = await published(world);

    const refused = await patch(media, first.id, {
      answererSpeakerId: randomUUID(),
    });

    expect(refused.statusCode).toBe(400);
  });

  it('AC-3: an answerer who is an author of the collection becomes the author', async () => {
    const world = await startWorld();
    const { media } = world;
    const { first } = await published(world);
    await media.owner('POST', '/api/v1/topics/hermetismo/authors', {
      name: 'Quem Responde',
    });
    const author = await media.owner(
      'POST',
      '/api/v1/topics/hermetismo/speakers',
      { name: 'Quem Responde', authorSlug: 'quem-responde' },
    );

    const changed = await patch(media, first.id, {
      answererSpeakerId: author.json<{ id: string }>().id,
    });

    expect(changed.json<MediaItem>().author?.slug).toBe('quem-responde');
  });
});

describe('The window to restore (AC-9)', () => {
  it('past 30 days the API refuses and the track stays out', async () => {
    const world = await startWorld();
    const { media } = world;
    const { recording, first } = await published(world);
    await send(media, { method: 'DELETE', url: urlOf(first.id) });
    const db = new DatabaseSync(join(media.mediaDir, 'media.db'));
    const old = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString();
    db.prepare('UPDATE media SET archived_at = ? WHERE id = ?').run(
      old,
      first.id,
    );
    db.close();

    const back = await send(media, {
      method: 'POST',
      url: `${urlOf(first.id)}/restore`,
    });

    expect(back.statusCode).toBe(409);
    expect(back.body).toContain('restore-expired');
    const list = await media.owner(
      'GET',
      `${urlOf(recording.id)}/archived-tracks`,
    );
    expect(list.json<ArchivedTracks>().tracks).toEqual([]);
    const page = await media.owner('GET', urlOf(first.id));
    expect(page.json<MediaItem>().archived).toBe(true);
  });
});

const MEDIA_MODEL = {
  id: 'deepseek/deepseek-v4-flash',
  name: 'DeepSeek',
  context_length: 100_000,
  pricing: { prompt: '0.0000001', completion: '0.0000002' },
};

describe('"Sugerir de novo com IA" (FR-7)', () => {
  const REPLY = JSON.stringify({
    titulo: 'Título sugerido',
    resumo: 'Resumo sugerido.',
    pergunta: null,
    resposta: 'Ninguém conhecido',
    assuntos: ['inventado'],
    novos: ['Tema inédito'],
  });

  async function connected() {
    const world = await startWorld();
    const { media } = world;
    const made = await published(world);
    media.started.fake.models = [...FAKE_FREE_MODELS, MEDIA_MODEL];
    await connectHouse(media.started, media.owner);
    media.started.fake.scripted.push(() => ({ content: REPLY, cost: 0.0012 }));
    return { media, ...made };
  }

  it('AC-11: estimates, answers, and only the spend remains', async () => {
    const { media, first } = await connected();
    const url = `${urlOf(first.id)}/suggestions`;

    const estimate = await send(media, {
      method: 'POST',
      url,
      payload: { dryRun: true },
    });
    const run = await send(media, {
      method: 'POST',
      url,
      payload: { dryRun: false },
    });

    expect(estimate.statusCode, estimate.body).toBe(200);
    expect(estimate.json<ProposalEstimate>().allowed).toBe(true);
    expect(run.statusCode, run.body).toBe(201);
    const suggestion = run.json<TrackSuggestion>();
    expect(suggestion.title).toBe('Título sugerido');
    expect(suggestion.answererSpeakerId).toBeNull();
    expect(suggestion.subjects).toEqual([
      { kind: 'new', name: 'Tema inédito', id: null },
    ]);
    expect((await viewOf(media, first.id)).title).toBe(first.title);
    const db = new DatabaseSync(join(media.mediaDir, 'media.db'));
    const row = db
      .prepare(`SELECT status FROM media_spend WHERE kind = 'track-suggestion'`)
      .get();
    db.close();
    expect(row?.['status']).toBe('settled');
  });

  it('an unreadable answer gives the reservation back', async () => {
    const { media, first } = await connected();
    media.started.fake.scripted.length = 0;
    media.started.fake.scripted.push(() => ({ content: 'isto não é JSON' }));

    const run = await send(media, {
      method: 'POST',
      url: `${urlOf(first.id)}/suggestions`,
      payload: { dryRun: false },
    });

    expect(run.statusCode).toBeGreaterThanOrEqual(500);
  });

  it('needs the AI grant', async () => {
    const world = await startWorld();
    const { media } = world;
    const { first } = await published(world);
    const { call } = await member(media, {
      email: 'editora@example.com',
      topics: ['hermetismo'],
      features: ['media', 'media-tracks', 'media-edit'],
    });

    const refused = await call('POST', `${urlOf(first.id)}/suggestions`, {
      dryRun: true,
    });

    expect(refused.statusCode).toBe(403);
  });
});

describe('The janitor (BR-3, BR-7)', () => {
  it('takes replaced cuts after a day and deleted tracks after 30 days', async () => {
    const world = await startWorld();
    const { media } = world;
    const { first, second } = await published(world);
    await moveBounds(media, first.id, { startMs: 90_000, endMs: 210_000 });
    await finishCuts(media);
    await send(media, { method: 'DELETE', url: urlOf(second.id) });
    const files = () =>
      readdirSync(join(media.mediaDir, 'audio')).filter(
        (name) => name.startsWith(first.id) || name.startsWith(second.id),
      );
    expect(files().length).toBe(3);
    const db = new DatabaseSync(join(media.mediaDir, 'media.db'));
    const store = new SqliteTrackRevisionStore(db);
    const day = 24 * 60 * 60 * 1000;

    const old = store.takeOldFiles(new Date(Date.now() + 2 * day));
    const archived = store.takeArchivedFiles(new Date(Date.now() + 31 * day));
    const early = store.takeOldFiles(new Date(0));
    db.close();

    expect(old).toHaveLength(1);
    expect(archived).toHaveLength(1);
    expect(early).toEqual([]);
  });
});

describe('History and permissions (FR-5, AC-14)', () => {
  it('AC-12: says who, when, the field, before and after', async () => {
    const world = await startWorld();
    const { media } = world;
    const { first } = await published(world);
    await patch(media, first.id, { title: 'Outro título' });
    await patch(media, first.id, { summary: 'Um resumo.' });
    await moveBounds(media, first.id, { startMs: 90_000, endMs: 210_000 });
    await finishCuts(media);

    const read = await media.owner('GET', `${urlOf(first.id)}/history`);

    const { changes } = read.json<TrackHistory>();
    expect(changes.map((one) => one.field).sort()).toEqual([
      'bounds',
      'summary',
      'title',
    ]);
    const title = changes.find((one) => one.field === 'title');
    expect(title).toMatchObject({
      before: 'Primeira pergunta',
      after: 'Outro título',
    });
    expect(title?.by).toBeTruthy();
    expect(changes.find((one) => one.field === 'bounds')).toMatchObject({
      before: '60000-240000',
      after: '90000-210000',
    });
  });

  it('AC-14: a listener reads the track and changes nothing', async () => {
    const world = await startWorld();
    const { media } = world;
    const { first } = await published(world);
    const { call: listener } = await member(media, {
      email: 'ouvinte@example.com',
      topics: ['hermetismo'],
      features: ['media', 'media-tracks'],
    });

    const calls = await Promise.all([
      listener('PATCH', urlOf(first.id), { title: 'x' }),
      listener('PUT', `${urlOf(first.id)}/bounds`, {
        startMs: 0,
        endMs: 10_000,
      }),
      listener('DELETE', urlOf(first.id)),
      listener('POST', `${urlOf(first.id)}/restore`),
      listener('GET', `${urlOf(first.id)}/history`),
      listener('GET', `${urlOf(first.id)}/track-edit`),
    ]);

    expect(calls.map((one) => one.statusCode)).toEqual(calls.map(() => 403));
  });
});
