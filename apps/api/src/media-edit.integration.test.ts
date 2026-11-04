import { randomUUID } from 'node:crypto';
import { cp, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type {
  CollectionSpeaker,
  MediaItem,
  MediaSpeakers,
  MediaTranscript,
} from '@kb-chat/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { closeApp, type Call } from '../test/ai-app-harness.js';
import {
  CONVERSATION_TURNS,
  leaseDiarization,
  pairDiarizer,
  requestVoices,
  sendTurns,
  transcribedItem,
  turnsOf,
} from '../test/diarization-harness.js';
import { FIXTURE_VAULT } from '../test/fixture-paths.js';
import {
  AUDIO,
  aRequest,
  convert,
  leaseJob,
  member,
  readyItem,
  startMedia,
  upload,
  type Media,
} from '../test/media-harness.js';

afterEach(closeApp);

const UPLOADER = ['search', 'media', 'media-upload'];
const urlOf = (id: string) => `/api/v1/media/${id}`;

/** A copy of the fixture vault with `udv`, `escola` and a sub-collection of `udv`. */
async function vaultWithCollections(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'kbchat-media-edit-'));
  await cp(FIXTURE_VAULT, root, { recursive: true });
  const sub = join(root, 'udv', 'palavra-do-mestre');
  await mkdir(sub, { recursive: true });
  await mkdir(join(root, 'escola'), { recursive: true });
  await writeFile(join(root, 'udv', 'topic.yaml'), 'title: UDV\n');
  await writeFile(join(sub, 'topic.yaml'), 'title: Palavra do Mestre\n');
  await writeFile(join(root, 'escola', 'topic.yaml'), 'title: Escola\n');
  return root;
}

const startWithCollections = async () =>
  startMedia({ vault: await vaultWithCollections() });

/** A member who sent a ready audio to `hermetismo`. */
async function uploaderWithItem(media: Media, topics: string[]) {
  const person = await member(media, {
    email: 'envia@example.com',
    topics,
    features: UPLOADER,
  });
  const created = await person.call(
    'POST',
    '/api/v1/topics/hermetismo/media',
    aRequest(),
  );
  expect(created.statusCode, created.body).toBe(201);
  const id: string = created.json().id;
  const sent = await upload(media, {
    id,
    body: AUDIO,
    headers: person.headers,
  });
  expect(sent.statusCode, sent.body).toBe(200);
  await convert(media, await leaseJob(media));
  return { ...person, id };
}

const patch = (call: Call, id: string, body: object) =>
  call('PATCH', urlOf(id), body);

describe('Editing a media item (KBC-050 FR-1)', () => {
  it('AC-1: who sent it changes the title; the list and the item show it, playable', async () => {
    const media = await startMedia();
    const { call, id } = await uploaderWithItem(media, ['hermetismo']);
    const saved = await patch(call, id, { title: '  A conselheira do rei ' });
    expect(saved.statusCode, saved.body).toBe(200);
    expect(saved.json()).toMatchObject({
      id,
      title: 'A conselheira do rei',
      topic: 'hermetismo',
      status: 'ready',
      author: { slug: 'mestre-laercio' },
      canEdit: true,
    });
    const list = await call('GET', '/api/v1/topics/hermetismo/media');
    expect(list.json().items[0].title).toBe('A conselheira do rei');
    const stream = await call('GET', `${urlOf(id)}/stream`);
    expect(stream.statusCode).toBe(200);
  });

  it('AC-6, BR-4: a new title leaves the position, bookmarks, file and length as they were', async () => {
    const media = await startMedia();
    const item = await readyItem(media);
    const url = urlOf(item.id);
    await media.owner('PUT', `${url}/progress`, {
      positionMs: 60_000,
      basedOn: null,
    });
    await media.owner('POST', `${url}/bookmarks`, {
      id: randomUUID(),
      positionMs: 120_000,
      note: 'lei do ritmo',
    });
    const before = (await media.owner('GET', url)).json<MediaItem>();
    const saved = await patch(media.owner, item.id, { title: 'Outro título' });
    expect(saved.json()).toEqual({ ...before, title: 'Outro título' });
    const bookmarks = await media.owner('GET', `${url}/bookmarks`);
    expect(bookmarks.json().items).toMatchObject([{ positionMs: 120_000 }]);
  });

  it('changes the author, and blank is "Outros autores"', async () => {
    const media = await startMedia();
    const item = await readyItem(media);
    const added = await media.owner(
      'POST',
      '/api/v1/topics/hermetismo/authors',
      { name: 'Ana Lima' },
    );
    const named = await patch(media.owner, item.id, {
      author: added.json().slug,
    });
    expect(named.json().author).toMatchObject({ name: 'Ana Lima' });
    const none = await patch(media.owner, item.id, { author: null });
    expect(none.json().author).toBeNull();
    const read = await media.owner('GET', urlOf(item.id));
    expect(read.json().author).toBeNull();
  });

  it('never leaves the old column naming the Mestre for another author (ADR 0030 §4)', async () => {
    const media = await startMedia();
    const item = await readyItem(media);
    await patch(media.owner, item.id, { author: null });
    const db = new DatabaseSync(join(media.mediaDir, 'media.db'));
    const row = db
      .prepare('SELECT authorship FROM media WHERE id = ?')
      .get(item.id);
    db.close();
    expect(row?.['authorship']).toBe('outros-autores');
  });

  it.each([
    [{ title: '   ' }, 'a blank title'],
    [{ title: 'a'.repeat(201) }, 'a title of 201 characters'],
    [{ authorship: 'sintese' }, 'an unknown field'],
    [{ author: 'ninguem' }, 'an author the collection does not have'],
  ])('AC-5: refuses %o (%s) and changes nothing', async (body, reason) => {
    expect(reason).not.toBe('');
    const media = await startMedia();
    const item = await readyItem(media);
    const refused = await patch(media.owner, item.id, body);
    expect(refused.statusCode).toBe(400);
    expect(refused.json().error.code).toBe('VALIDATION_FAILED');
    const read = await media.owner('GET', urlOf(item.id));
    expect(read.json().title).toBe(item.title);
  });

  it('takes a title of 200 characters', async () => {
    const media = await startMedia();
    const item = await readyItem(media);
    const title = 'a'.repeat(200);
    const saved = await patch(media.owner, item.id, { title });
    expect(saved.statusCode).toBe(200);
  });
});

describe('Who may edit (KBC-050 BR-1)', () => {
  it('AC-3: a member who did not send it gets 403 and no canEdit', async () => {
    const media = await startMedia();
    const item = await readyItem(media);
    const other = await member(media, {
      email: 'outra@example.com',
      topics: ['hermetismo'],
      features: UPLOADER,
    });
    const refused = await patch(other.call, item.id, { title: 'Meu' });
    expect(refused.statusCode).toBe(403);
    expect(refused.json().error.code).toBe('FORBIDDEN');
    const read = await other.call('GET', urlOf(item.id));
    expect(read.json()).toMatchObject({ title: item.title, canEdit: false });
  });

  it('a master edits what someone else sent', async () => {
    const media = await startMedia();
    const { id } = await uploaderWithItem(media, ['hermetismo']);
    const saved = await patch(media.owner, id, { title: 'Corrigido' });
    expect(saved.json()).toMatchObject({ title: 'Corrigido', canEdit: true });
  });

  it('BR-1: who sent it and lost "enviar" no longer edits', async () => {
    const media = await startMedia();
    const { call, id } = await uploaderWithItem(media, ['hermetismo']);
    const people = await media.owner('GET', '/api/v1/people');
    const person = people
      .json<{ items: { id: string; email: string }[] }>()
      .items.find((one) => one.email === 'envia@example.com');
    await media.owner('PATCH', `/api/v1/people/${person?.id}`, {
      features: ['search', 'media'],
    });
    expect((await patch(call, id, { title: 'Novo' })).statusCode).toBe(403);
    const read = await call('GET', urlOf(id));
    expect(read.json().canEdit).toBe(false);
  });

  it('answers 404 without access to the collection', async () => {
    const media = await startMedia();
    const item = await readyItem(media);
    const stranger = await member(media, {
      email: 'fora@example.com',
      topics: [],
      features: UPLOADER,
    });
    const refused = await patch(stranger.call, item.id, { title: 'Meu' });
    expect(refused.statusCode).toBe(404);
    expect(refused.json().error.code).toBe('MEDIA_NOT_FOUND');
  });

  it('answers 404 for an item that does not exist', async () => {
    const media = await startMedia();
    const refused = await patch(media.owner, randomUUID(), { title: 'Novo' });
    expect(refused.statusCode).toBe(404);
  });

  it('shows canEdit in the library too', async () => {
    const media = await startMedia();
    await uploaderWithItem(media, ['hermetismo']);
    const other = await member(media, {
      email: 'biblioteca@example.com',
      topics: ['hermetismo'],
      features: ['media', 'media-library'],
    });
    const page = await other.call('GET', '/api/v1/media/library');
    expect(page.json().items).toMatchObject([{ canEdit: false }]);
    const mine = await media.owner('GET', '/api/v1/media/library');
    expect(mine.json().items).toMatchObject([{ canEdit: true }]);
  });
});

describe('Moving to another collection (KBC-050 BR-2, FR-1)', () => {
  it('AC-2: leaves the old list, shows in the new one, the position goes along', async () => {
    const media = await startWithCollections();
    const { call, id } = await uploaderWithItem(media, ['hermetismo', 'udv']);
    await call('PUT', `${urlOf(id)}/progress`, {
      positionMs: 60_000,
      basedOn: null,
    });
    await media.owner('POST', '/api/v1/topics/udv/authors', {
      name: 'Mestre Laércio',
    });
    const saved = await patch(call, id, { topic: 'udv' });
    expect(saved.statusCode, saved.body).toBe(200);
    expect(saved.json()).toMatchObject({ topic: 'udv', positionMs: 60_000 });
    const old = await call('GET', '/api/v1/topics/hermetismo/media');
    expect(old.json().items).toEqual([]);
    const moved = await call('GET', '/api/v1/topics/udv/media');
    expect(moved.json().items).toMatchObject([{ id, positionMs: 60_000 }]);
  });

  it('BR-2: who cannot see the new collection stops seeing the audio', async () => {
    const media = await startWithCollections();
    const item = await readyItem(media);
    const reader = await member(media, {
      email: 'hermetismo@example.com',
      topics: ['hermetismo'],
      features: ['media'],
    });
    await patch(media.owner, item.id, { topic: 'udv', author: null });
    const read = await reader.call('GET', urlOf(item.id));
    expect(read.statusCode).toBe(404);
  });

  it('AC-4: a collection the person does not see answers as one that does not exist', async () => {
    const media = await startWithCollections();
    const { call, id } = await uploaderWithItem(media, ['hermetismo']);
    const hidden = await patch(call, id, { topic: 'udv', author: null });
    expect(hidden.statusCode).toBe(404);
    expect(hidden.json().error.code).toBe('TOPIC_NOT_FOUND');
    const missing = await patch(media.owner, id, { topic: 'nao-existe' });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toEqual(hidden.json());
    const read = await call('GET', urlOf(id));
    expect(read.json().topic).toBe('hermetismo');
  });

  it('a sub-collection keeps the author: it uses the same list', async () => {
    const media = await startWithCollections();
    const added = await media.owner('POST', '/api/v1/topics/udv/authors', {
      name: 'Ana Lima',
    });
    const created = await media.owner(
      'POST',
      '/api/v1/topics/udv/media',
      aRequest({ author: added.json().slug }),
    );
    const saved = await patch(media.owner, created.json().id, {
      topic: 'udv/palavra-do-mestre',
    });
    expect(saved.statusCode, saved.body).toBe(200);
    expect(saved.json().author).toMatchObject({ name: 'Ana Lima' });
  });

  it('refuses to lose the author: the new collection must have them', async () => {
    const media = await startWithCollections();
    const item = await readyItem(media);
    const refused = await patch(media.owner, item.id, { topic: 'udv' });
    expect(refused.statusCode).toBe(400);
    expect(refused.json().error.details).toEqual({ field: 'author' });
    const read = await media.owner('GET', urlOf(item.id));
    expect(read.json().topic).toBe('hermetismo');
  });

  it('takes the new author with the move', async () => {
    const media = await startWithCollections();
    const item = await readyItem(media);
    const added = await media.owner('POST', '/api/v1/topics/udv/authors', {
      name: 'Ana Lima',
    });
    const saved = await patch(media.owner, item.id, {
      topic: 'udv',
      author: added.json().slug,
    });
    expect(saved.json()).toMatchObject({
      topic: 'udv',
      author: { name: 'Ana Lima' },
    });
  });

  it('moves an item that is still waiting for its file', async () => {
    const media = await startWithCollections();
    const created = await media.owner(
      'POST',
      '/api/v1/topics/hermetismo/media',
      aRequest({ author: null }),
    );
    const id: string = created.json().id;
    await patch(media.owner, id, { topic: 'udv' });
    const sent = await upload(media, { id, body: AUDIO });
    expect(sent.statusCode, sent.body).toBe(200);
    expect(sent.json().topic).toBe('udv');
  });
});

describe('Moving and the voices (KBC-050, KBC-065)', () => {
  /** A separated item with voice 1 named `name` and voice 2 the main author. */
  async function named(media: Media, name: string) {
    const { token } = await pairDiarizer(media);
    const mediaId = await transcribedItem(media, token);
    expect((await requestVoices(media, mediaId)).statusCode).toBe(202);
    const job = await leaseDiarization(media, token);
    const body = turnsOf(job, CONVERSATION_TURNS);
    await sendTurns(media, { token, job, body });
    const speakers = '/api/v1/topics/hermetismo/speakers';
    const person = await media.owner('POST', speakers, { name });
    const author = await media.owner('POST', speakers, {
      name: 'Mestre',
      authorSlug: 'mestre-laercio',
    });
    const label = async (voice: number, speaker: CollectionSpeaker) => {
      const saved = await media.owner(
        'PUT',
        `${urlOf(mediaId)}/voices/${voice}`,
        { version: 1, speakerId: speaker.id, audience: false },
      );
      expect(saved.statusCode, saved.body).toBe(200);
    };
    await label(1, person.json());
    await label(2, author.json());
    return { mediaId, person: person.json<CollectionSpeaker>() };
  }

  const voicesOf = async (media: Media, mediaId: string) => {
    const read = await media.owner('GET', `${urlOf(mediaId)}/transcript`);
    return read.json<MediaTranscript>().voiceNames;
  };

  const listOf = async (media: Media, topic: string) => {
    const read = await media.owner('GET', `/api/v1/topics/${topic}/speakers`);
    return read.json<{ items: CollectionSpeaker[] }>().items;
  };

  it('keeps every name on screen and carries them to the new list', async () => {
    const media = await startWithCollections();
    const { mediaId, person } = await named(media, 'Maria da Paz');
    const saved = await patch(media.owner, mediaId, {
      topic: 'udv',
      author: null,
    });
    expect(saved.statusCode, saved.body).toBe(200);
    const names = (await voicesOf(media, mediaId))?.filter((one) => one.name);
    expect(names?.map((one) => one.name)).toEqual([
      'Maria da Paz',
      'Mestre Laércio',
    ]);
    const list = await listOf(media, 'udv');
    expect(list.map((one) => one.name)).toEqual([
      'Maria da Paz',
      'Mestre Laércio',
    ]);
    expect(list.map((one) => one.id)).not.toContain(person.id);
    expect(names?.map((one) => one.speakerId).sort()).toEqual(
      list.map((one) => one.id).sort(),
    );
    const old = await listOf(media, 'hermetismo');
    expect(old.map((one) => one.id)).toContain(person.id);
  });

  it('a voice can be named again from the new list', async () => {
    const media = await startWithCollections();
    const { mediaId } = await named(media, 'Maria da Paz');
    await patch(media.owner, mediaId, { topic: 'udv', author: null });
    const [speaker] = await listOf(media, 'udv');
    const renamed = await media.owner('PUT', `${urlOf(mediaId)}/voices/2`, {
      version: 1,
      speakerId: speaker?.id ?? null,
      audience: false,
    });
    expect(renamed.statusCode, renamed.body).toBe(200);
  });

  it('uses the speaker the new list already has, by name', async () => {
    const media = await startWithCollections();
    const { mediaId } = await named(media, 'Maria da Paz');
    const existing = await media.owner('POST', '/api/v1/topics/udv/speakers', {
      name: 'MARIA DA PÁZ',
    });
    await patch(media.owner, mediaId, { topic: 'udv', author: null });
    const names = await voicesOf(media, mediaId);
    expect(names?.[0]?.speakerId).toBe(existing.json().id);
    expect(await listOf(media, 'udv')).toHaveLength(2);
  });

  it('keeps the author link when the new collection has that author', async () => {
    const media = await startWithCollections();
    const { mediaId } = await named(media, 'Maria da Paz');
    await media.owner('POST', '/api/v1/topics/udv/authors', {
      name: 'Mestre Laércio',
    });
    await patch(media.owner, mediaId, { topic: 'udv' });
    const list = await listOf(media, 'udv');
    expect(list.find((one) => one.name === 'Mestre Laércio')).toMatchObject({
      authorSlug: 'mestre-laercio',
    });
  });

  it('a sub-collection keeps the same speakers', async () => {
    const media = await startWithCollections();
    const { mediaId } = await named(media, 'Maria da Paz');
    await patch(media.owner, mediaId, { topic: 'udv', author: null });
    const before = await voicesOf(media, mediaId);
    await patch(media.owner, mediaId, { topic: 'udv/palavra-do-mestre' });
    expect(await voicesOf(media, mediaId)).toEqual(before);
    expect(await listOf(media, 'udv')).toHaveLength(2);
  });

  it('a refused move carries nothing', async () => {
    const media = await startWithCollections();
    const { mediaId } = await named(media, 'Maria da Paz');
    const refused = await patch(media.owner, mediaId, { topic: 'udv' });
    expect(refused.statusCode).toBe(400);
    expect(await listOf(media, 'udv')).toEqual([]);
  });

  it('the voices panel still reads after a move', async () => {
    const media = await startWithCollections();
    const { mediaId } = await named(media, 'Maria da Paz');
    await patch(media.owner, mediaId, { topic: 'udv', author: null });
    const read = await media.owner('GET', `${urlOf(mediaId)}/speakers`);
    expect(read.statusCode).toBe(200);
    expect(
      read.json<MediaSpeakers>().diarization?.labels.map((one) => one.name),
    ).toEqual(['Maria da Paz', 'Mestre Laércio', null]);
  });
});

describe('Saving time (KBC-050 NFR-1)', () => {
  it('saves in up to 500 ms with 1,000 audios in the collection', async () => {
    const media = await startMedia();
    const item = await readyItem(media);
    const db = new DatabaseSync(join(media.mediaDir, 'media.db'));
    const copy = db.prepare(
      `INSERT INTO media (id, topic, title, authorship, owner_principal, file_name,
         upload_bytes, status, created_at, updated_at)
       SELECT ?, topic, title, authorship, owner_principal, file_name, upload_bytes, status,
         created_at, updated_at FROM media WHERE id = ?`,
    );
    for (let n = 1; n < 1_000; n++) copy.run(randomUUID(), item.id);
    db.close();
    const started = performance.now();
    const saved = await patch(media.owner, item.id, { title: 'Rápido' });
    expect(saved.statusCode).toBe(200);
    expect(performance.now() - started).toBeLessThanOrEqual(500);
  });
});
