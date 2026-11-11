/**
 * Media with an access level (KBC-105, ADR 0036 §3, §5–§7): the level is chosen on sending,
 * can change afterwards, and no audio above a member's level reaches them anywhere.
 */
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { MediaItem, SearchResponse } from '@kb-chat/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import {
  OWNER_EMAIL,
  caller,
  closeApp,
  signIn,
  start,
  type Call,
} from '../test/ai-app-harness.js';
import {
  SIX,
  createScale,
  levelAudit,
  memberOf,
  setPersonLevel,
  startLevels,
  type LevelsWorld,
} from '../test/levels-world.js';
import { AUDIO, leaseJob, upload, type Media } from '../test/media-harness.js';
import {
  approve,
  convertLong,
  finishCuts,
  say,
} from '../test/track-items-harness.js';
import { pair } from '../test/transcription-harness.js';

afterEach(closeApp);

const MEDIA_FEATURES = [
  'search',
  'media',
  'media-upload',
  'media-edit',
  'media-library',
];
const HIDDEN = 'Segredo Velado do Cume';
const OPEN = 'Lua do Grau Medio';

const mediaOf = (world: LevelsWorld): Media => ({
  started: world.started,
  owner: world.owner,
  ownerHeaders: world.ownerHeaders,
  mediaDir: join(world.started.state, 'media'),
});

/** A Mac that only transcribes (as in the track-items harness). */
async function transcriber(media: Media): Promise<string> {
  const { token, transcriber: mac } = await pair(media);
  const unmarked = await media.owner(
    'PATCH',
    `/api/v1/media/transcribers/${mac.id}`,
    { kinds: ['transcribe'] },
  );
  expect(unmarked.statusCode, unmarked.body).toBe(200);
  return token;
}

const request = (title: string, fields: object = {}) => ({
  title,
  author: null,
  fileName: 'palestra.mp3',
  bytes: AUDIO.length,
  ...fields,
});

/** Sent by `call` (the owner by default), converted and, with `token`, transcribed. */
async function sent(
  world: LevelsWorld,
  input: {
    readonly title: string;
    readonly level?: string;
    readonly topic?: string;
    readonly sha256?: string;
    readonly token?: string;
    readonly headers?: Record<string, string>;
    readonly call?: Call;
  },
): Promise<MediaItem> {
  const media = mediaOf(world);
  const call = input.call ?? world.owner;
  const created = await call(
    'POST',
    `/api/v1/topics/${input.topic ?? 'hermetismo'}/media`,
    request(input.title, {
      ...(input.level && { level: input.level }),
      ...(input.sha256 && { sha256: input.sha256 }),
    }),
  );
  expect(created.statusCode, created.body).toBe(201);
  const item: MediaItem = created.json();
  if (input.sha256) return item;
  const uploaded = await upload(media, {
    id: item.id,
    body: AUDIO,
    headers: input.headers ?? world.ownerHeaders,
  });
  expect(uploaded.statusCode, uploaded.body).toBe(200);
  if (!input.token) return item;
  await convertLong(media, await leaseJob(media));
  await say({ media, token: input.token }, [
    { at: 10, text: `a lua ${input.title.toLowerCase()}` },
  ]);
  return item;
}

/** QS < CI < CDC on hermetismo, Ana (CI) with media, and the Mac. */
async function scaledWorld() {
  const world = await startLevels(SIX, { media: true });
  const ana = await memberOf(world, 'ana@example.com', {
    topics: ['hermetismo', 'alquimia'],
    features: MEDIA_FEATURES,
  });
  await createScale(world, ['QS', 'CI', 'CDC']);
  await setPersonLevel(world, ana.id, { hermetismo: 'ci' });
  const token = await transcriber(mediaOf(world));
  return { world, ana, token };
}

describe('Media with an access level (KBC-105)', () => {
  it('AC-1, AC-2, AC-3: the level is required, offered up to the sender, and absent without a scale', async () => {
    const { world, ana } = await scaledWorld();
    const url = '/api/v1/topics/hermetismo/media';

    const none = await ana.call('POST', url, request('Sem nível'));
    expect(none.statusCode).toBe(400);
    expect(none.json().error.code).toBe('LEVEL_REQUIRED');
    const above = await ana.call(
      'POST',
      url,
      request('Acima', { level: 'cdc' }),
    );
    expect(above.statusCode).toBe(403);
    expect(above.json().error.code).toBe('LEVEL_ABOVE_YOURS');
    const unknown = await ana.call(
      'POST',
      url,
      request('Outro', { level: 'xyz' }),
    );
    expect(unknown.statusCode).toBe(400);
    const own = await ana.call('POST', url, request('No meu', { level: 'ci' }));
    expect(own.statusCode, own.body).toBe(201);
    expect(own.json().level).toEqual({ id: 'ci', code: 'CI' });

    const choices = await ana.call('GET', `${url}/levels`);
    expect(choices.statusCode, choices.body).toBe(200);
    expect(choices.json().levels).toEqual([
      { id: 'qs', code: 'QS' },
      { id: 'ci', code: 'CI' },
    ]);
    const all = await world.owner('GET', `${url}/levels`);
    expect(all.json().levels.map((one: { id: string }) => one.id)).toEqual([
      'qs',
      'ci',
      'cdc',
    ]);

    // AC-3: a collection without a scale is as before.
    const plain = '/api/v1/topics/alquimia/media';
    expect((await ana.call('GET', `${plain}/levels`)).json().levels).toEqual(
      [],
    );
    const before = await ana.call('POST', plain, request('Como antes'));
    expect(before.statusCode, before.body).toBe(201);
    expect(before.json().level).toBeUndefined();
    const named = await ana.call(
      'POST',
      plain,
      request('Com nível', { level: 'ci' }),
    );
    expect(named.statusCode).toBe(400);
  });

  it('AC-4, AC-5, AC-6, AC-11: an audio above the member answers 404 everywhere and counts nowhere', async () => {
    const { world, ana, token } = await scaledWorld();
    const open = await sent(world, { title: OPEN, level: 'ci', token });
    const hidden = await sent(world, { title: HIDDEN, level: 'cdc', token });
    const id = hidden.id;

    // AC-4: every route of the item answers as if it did not exist.
    for (const [method, url] of [
      ['GET', `/api/v1/media/${id}`],
      ['GET', `/api/v1/media/${id}/stream`],
      ['GET', `/api/v1/media/${id}/subtitles.vtt`],
      ['GET', `/api/v1/media/${id}/transcript`],
      ['GET', `/api/v1/media/${id}/transcript/words?from=0&count=10`],
      ['GET', `/api/v1/media/${id}/waveform`],
      ['GET', `/api/v1/media/${id}/silences`],
      ['GET', `/api/v1/media/${id}/bookmarks`],
      ['GET', `/api/v1/media/${id}/speakers`],
    ] as const) {
      const answer = await ana.call(method, url);
      expect(answer.statusCode, `${method} ${url}: ${answer.body}`).toBe(404);
      expect(answer.body).not.toContain(HIDDEN);
    }
    const progress = await ana.call('PUT', `/api/v1/media/${id}/progress`, {
      positionMs: 1000,
      basedOn: null,
    });
    expect(progress.statusCode).toBe(404);
    const marked = await ana.call('POST', `/api/v1/media/${id}/bookmarks`, {
      id: randomUUID(),
      positionMs: 1000,
    });
    expect(marked.statusCode).toBe(404);
    const edited = await ana.call('PATCH', `/api/v1/media/${id}`, {
      title: 'Outro',
    });
    expect(edited.statusCode).toBe(404);
    // The open one plays for her.
    expect((await ana.call('GET', `/api/v1/media/${open.id}`)).statusCode).toBe(
      200,
    );

    // AC-5: "Na fala" shows only the CI audio and counts one.
    const found = await ana.call('POST', '/api/v1/topics/hermetismo/searches', {
      q: 'lua',
      kinds: ['audio'],
    });
    expect(found.statusCode, found.body).toBe(200);
    const body = found.json<SearchResponse>();
    expect(body.media.map((hit) => hit.title)).toEqual([OPEN]);
    expect(body.kinds.audio).toBe(1);
    expect(found.body).not.toContain(HIDDEN);

    // AC-6: the collection's list, the library and its search.
    for (const url of [
      '/api/v1/topics/hermetismo/media',
      '/api/v1/media/library',
      '/api/v1/media/library?topic=hermetismo',
      '/api/v1/media/library/search?q=lua',
      '/api/v1/media/library/home',
      '/api/v1/media/processing',
      '/api/v1/media/preparations',
      '/api/v1/media/bookmarks',
    ]) {
      const answer = await ana.call('GET', url);
      expect(answer.statusCode, `${url}: ${answer.body}`).toBe(200);
      expect(answer.body, url).not.toContain(HIDDEN);
      expect(answer.body, url).not.toContain(id);
    }
    const list = await ana.call('GET', '/api/v1/topics/hermetismo/media');
    expect(list.json().items.map((one: MediaItem) => one.title)).toEqual([
      OPEN,
    ]);
    // Members see no level badge on what they cannot edit (ADR 0036 §9).
    expect(list.json().items[0].level).toBeUndefined();
    const library = await ana.call('GET', '/api/v1/media/library');
    expect(library.json().total).toBe(1);

    // AC-11: the master sees and hears both, each with its level.
    const ownerList = await world.owner(
      'GET',
      '/api/v1/topics/hermetismo/media',
    );
    expect(
      ownerList
        .json()
        .items.map((one: MediaItem) => [one.title, one.level?.code])
        .sort(),
    ).toEqual([
      [OPEN, 'CI'],
      [HIDDEN, 'CDC'],
    ]);
    const ownerLibrary = await world.owner('GET', '/api/v1/media/library');
    expect(
      ownerLibrary.json().items.map((one: MediaItem) => one.level?.code),
    ).toEqual(expect.arrayContaining(['CI', 'CDC']));
    expect((await world.owner('GET', `/api/v1/media/${id}`)).statusCode).toBe(
      200,
    );
    const ownerSearch = await world.owner(
      'POST',
      '/api/v1/topics/hermetismo/searches',
      { q: 'lua', kinds: ['audio'] },
    );
    expect(ownerSearch.json<SearchResponse>().kinds.audio).toBe(2);
  }, 60_000);

  it('AC-6: a bookmark and an own upload leave the member once raised above her level', async () => {
    const { world, ana } = await scaledWorld();
    const open = await sent(world, { title: OPEN, level: 'ci' });
    const mark = await ana.call('POST', `/api/v1/media/${open.id}/bookmarks`, {
      id: randomUUID(),
      positionMs: 0,
    });
    expect(mark.statusCode, mark.body).toBe(201);
    const own = await sent(world, {
      title: 'Minha Gravação Subida',
      level: 'ci',
      call: ana.call,
      headers: ana.headers,
    });
    expect((await ana.call('GET', '/api/v1/media/processing')).body).toContain(
      own.id,
    );

    for (const item of [open, own]) {
      const raised = await world.owner('PATCH', `/api/v1/media/${item.id}`, {
        level: 'cdc',
      });
      expect(raised.statusCode, raised.body).toBe(200);
      expect(raised.json().level).toEqual({ id: 'cdc', code: 'CDC' });
    }

    const mine = await ana.call('GET', '/api/v1/media/bookmarks');
    expect(mine.json().items).toEqual([]);
    for (const url of [
      '/api/v1/media/processing',
      '/api/v1/topics/hermetismo/media',
      '/api/v1/media/library',
    ]) {
      const answer = await ana.call('GET', url);
      expect(answer.body, url).not.toContain(own.id);
      expect(answer.body, url).not.toContain(OPEN);
    }
    expect((await ana.call('GET', `/api/v1/media/${own.id}`)).statusCode).toBe(
      404,
    );
  });

  it('AC-7: the same file at a hidden level is refused with no id and no title', async () => {
    const { world, ana } = await scaledWorld();
    const sha256 = 'b'.repeat(64);
    const hidden = await sent(world, { title: HIDDEN, level: 'cdc', sha256 });

    const check = await ana.call(
      'POST',
      '/api/v1/topics/hermetismo/media/check',
      { sha256, bytes: AUDIO.length, durationMs: null },
    );
    expect(check.statusCode, check.body).toBe(200);
    expect(check.json()).toEqual({ verdict: 'duplicate-hidden' });
    const create = await ana.call(
      'POST',
      '/api/v1/topics/hermetismo/media',
      request('De novo', { level: 'ci', sha256 }),
    );
    expect(create.statusCode).toBe(409);
    expect(create.json().error.code).toBe('MEDIA_DUPLICATE');
    expect(create.json().error.details).toEqual({ hidden: true });
    for (const body of [check.body, create.body]) {
      expect(body).not.toContain(hidden.id);
      expect(body).not.toContain(HIDDEN);
    }
    // The master still sees which item it is.
    const master = await world.owner(
      'POST',
      '/api/v1/topics/hermetismo/media/check',
      { sha256, bytes: AUDIO.length, durationMs: null },
    );
    expect(master.json().media.id).toBe(hidden.id);
  });

  it('BR-3, AC-8: the sender lowers the level of her audio; above her own is refused; the change is audited', async () => {
    const { world, ana } = await scaledWorld();
    const own = await sent(world, {
      title: 'Minha',
      level: 'ci',
      call: ana.call,
      headers: ana.headers,
    });

    const lowered = await ana.call('PATCH', `/api/v1/media/${own.id}`, {
      level: 'qs',
    });
    expect(lowered.statusCode, lowered.body).toBe(200);
    expect(lowered.json().level).toEqual({ id: 'qs', code: 'QS' });
    const above = await ana.call('PATCH', `/api/v1/media/${own.id}`, {
      level: 'cdc',
    });
    expect(above.statusCode).toBe(403);
    expect(above.json().error.code).toBe('LEVEL_ABOVE_YOURS');

    const audit = await levelAudit(world.started.state);
    expect(audit.filter((one) => one.target === own.id)).toEqual([
      expect.objectContaining({
        kind: 'item.level',
        by: 'ana@example.com',
        collection: 'hermetismo',
        before: 'ci',
        after: 'qs',
        count: { recordings: 1, tracks: 0 },
      }),
    ]);
  });

  it("AC-8, BR-7: the tracks copy their recording's level and follow its change, audited with 1 recording and 3 tracks", async () => {
    const { world, ana, token } = await scaledWorld();
    const recording = await sent(world, {
      title: 'Gravação com Faixas',
      level: 'ci',
      call: ana.call,
      headers: ana.headers,
      token,
    });
    const media = mediaOf(world);
    await approve(media, recording.id, [
      { startMs: 0, endMs: 60_000 },
      { startMs: 60_000, endMs: 120_000 },
      { startMs: 120_000, endMs: 180_000 },
    ]);
    await finishCuts(media);
    const tracksOf = async () => {
      const page = await world.owner('GET', '/api/v1/media/library');
      return page
        .json<{ items: (MediaItem & { tracks: MediaItem[] })[] }>()
        .items.find((one) => one.id === recording.id)
        ?.tracks.map((track) => track.level?.id);
    };
    expect(await tracksOf()).toEqual(['ci', 'ci', 'ci']);

    const lowered = await ana.call('PATCH', `/api/v1/media/${recording.id}`, {
      level: 'qs',
    });
    expect(lowered.statusCode, lowered.body).toBe(200);

    expect(await tracksOf()).toEqual(['qs', 'qs', 'qs']);
    const audit = await levelAudit(world.started.state);
    expect(audit.filter((one) => one.target === recording.id)).toEqual([
      expect.objectContaining({
        kind: 'item.level',
        before: 'ci',
        after: 'qs',
        count: { recordings: 1, tracks: 3 },
      }),
    ]);
    // Tracks stay closed to members in a collection with levels until KBC-106.
    const library = await ana.call('GET', '/api/v1/media/library');
    expect(
      library
        .json<{ items: (MediaItem & { tracks: MediaItem[] })[] }>()
        .items.find((one) => one.id === recording.id)?.tracks,
    ).toEqual([]);
  }, 60_000);

  it('AC-9: moving to another collection with levels needs one of its levels; to one without, the level goes', async () => {
    const { world } = await scaledWorld();
    const item = await sent(world, { title: OPEN, level: 'ci' });
    await createScale(world, ['A1', 'A2'], 'alquimia');

    const bare = await world.owner('PATCH', `/api/v1/media/${item.id}`, {
      topic: 'alquimia',
    });
    expect(bare.statusCode).toBe(400);
    expect(bare.json().error.code).toBe('LEVEL_REQUIRED');
    const wrong = await world.owner('PATCH', `/api/v1/media/${item.id}`, {
      topic: 'alquimia',
      level: 'ci',
    });
    expect(wrong.statusCode).toBe(400);
    const moved = await world.owner('PATCH', `/api/v1/media/${item.id}`, {
      topic: 'alquimia',
      level: 'a2',
    });
    expect(moved.statusCode, moved.body).toBe(200);
    expect(moved.json()).toMatchObject({
      topic: 'alquimia',
      level: { id: 'a2', code: 'A2' },
    });
    // Within the same scale a move keeps the level (the sub-collection uses its parent's).
    const back = await world.owner('PATCH', `/api/v1/media/${item.id}`, {
      topic: 'hermetismo',
      level: 'qs',
    });
    expect(back.json().level).toEqual({ id: 'qs', code: 'QS' });
    const inside = await world.owner('PATCH', `/api/v1/media/${item.id}`, {
      topic: 'hermetismo/aulas',
    });
    expect(inside.statusCode, inside.body).toBe(200);
    expect(inside.json().level).toEqual({ id: 'qs', code: 'QS' });
  });

  it('BR-4: to a collection without levels the level is cleared, and coming back asks again', async () => {
    const { world } = await scaledWorld();
    const item = await sent(world, { title: OPEN, level: 'ci' });

    const moved = await world.owner('PATCH', `/api/v1/media/${item.id}`, {
      topic: 'alquimia',
    });
    expect(moved.statusCode, moved.body).toBe(200);
    expect(moved.json().level).toBeUndefined();
    const back = await world.owner('PATCH', `/api/v1/media/${item.id}`, {
      topic: 'hermetismo',
    });
    expect(back.statusCode).toBe(400);
    expect(back.json().error.code).toBe('LEVEL_REQUIRED');
    const audit = await levelAudit(world.started.state);
    expect(
      audit
        .filter((one) => one.target === item.id)
        .map(({ before, after }) => [before, after]),
    ).toEqual([['ci', null]]);
  });

  it('AC-10, BR-8: a scale from before media held levels seeds the audios at start; one with no level is masters only', async () => {
    const { world } = await scaledWorld();
    const old = await sent(world, { title: OPEN, level: 'cdc' });
    const late = await sent(world, { title: HIDDEN, level: 'cdc' });
    // The database as it was before this migration ran, the scale already there.
    const dbPath = join(world.started.state, 'media', 'media.db');
    const writeRaw = (sql: string) => {
      const db = new DatabaseSync(dbPath);
      db.exec(sql);
      db.close();
    };
    writeRaw(`UPDATE media SET level = NULL; DELETE FROM media_level_seeds;`);
    await closeApp();

    const again = await start({
      media: true,
      state: world.started.state,
      vault: world.vault,
    });
    const ownerHeaders = await signIn(again, OWNER_EMAIL);
    const restarted: LevelsWorld = {
      ...world,
      started: again,
      owner: caller(again.app, ownerHeaders),
      ownerHeaders,
    };
    const anaAgain = await memberOf(restarted, 'ana2@example.com', {
      topics: ['hermetismo'],
      features: MEDIA_FEATURES,
    });
    // Seeded at the lowest level: QS reaches everyone with access.
    expect(
      (await anaAgain.call('GET', `/api/v1/media/${old.id}`)).statusCode,
    ).toBe(200);
    // A row with no level after the seed (an older image's) is for masters only.
    writeRaw(`UPDATE media SET level = NULL WHERE id = '${late.id}'`);
    expect(
      (await anaAgain.call('GET', `/api/v1/media/${late.id}`)).statusCode,
    ).toBe(404);
    const master = await restarted.owner('GET', `/api/v1/media/${late.id}`);
    expect(master.statusCode).toBe(200);
    expect(master.json().level).toBeNull();
    // The grant of ana2 records her lowest level after it (KBC-109 BR-4): the last bulk is the seed.
    const audit = await levelAudit(world.started.state);
    expect(audit.filter((one) => one.kind === 'bulk').at(-1)).toMatchObject({
      kind: 'bulk',
      by: 'kb-chat',
      collection: 'hermetismo',
      after: 'qs',
      count: { media: 2 },
    });
  }, 60_000);
});
