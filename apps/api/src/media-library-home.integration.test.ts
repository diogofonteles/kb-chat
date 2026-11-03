import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { LibraryItem } from '@kb-chat/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { closeApp, type Call } from '../test/ai-app-harness.js';
import {
  AUDIO,
  aRequest,
  convert,
  leaseJob,
  member,
  startMedia,
  upload,
  type Media,
} from '../test/media-harness.js';

afterEach(closeApp);

const LIBRARY = '/api/v1/media/library';
const HOME = '/api/v1/media/library/home';
const LISTENER = ['search', 'media', 'media-library'];

/** Writes to the media database as another process would (the API keeps its own handle). */
function withDb<T>(media: Media, work: (db: DatabaseSync) => T): T {
  const db = new DatabaseSync(join(media.mediaDir, 'media.db'));
  try {
    return work(db);
  } finally {
    db.close();
  }
}

/** A ready media sent by `call` (the owner by default) to `topic`. */
async function ready(
  media: Media,
  input: {
    title: string;
    topic?: string;
    authorship?: 'mestre-laercio' | 'outros-autores';
  },
): Promise<string> {
  const created = await media.owner(
    'POST',
    `/api/v1/topics/${input.topic ?? 'hermetismo'}/media`,
    aRequest({
      title: input.title,
      authorship: input.authorship ?? 'outros-autores',
    }),
  );
  expect(created.statusCode).toBe(201);
  const id: string = created.json().id;
  expect((await upload(media, { id, body: AUDIO })).statusCode).toBe(200);
  expect((await convert(media, await leaseJob(media))).statusCode).toBe(204);
  return id;
}

/** A position saved by the person's player, then dated (so the order is certain). */
async function playedAt(
  media: Media,
  who: Call,
  input: { id: string; positionMs: number; at: string },
) {
  const saved = await who('PUT', `/api/v1/media/${input.id}/progress`, {
    positionMs: input.positionMs,
    basedOn: null,
  });
  expect(saved.statusCode).toBe(200);
  withDb(media, (db) =>
    db
      .prepare(
        `UPDATE media_progress SET played_at = ? WHERE media_id = ? AND updated_at =
           (SELECT MAX(updated_at) FROM media_progress WHERE media_id = ?)`,
      )
      .run(input.at, input.id, input.id),
  );
}

const titles = (items: readonly LibraryItem[]) =>
  items.map((item) => item.title);

describe('Media library: access (KBC-051 BR-1)', () => {
  it('answers 403 to "Ouvir mídia" alone and to the library without "Ouvir mídia" (AC-2)', async () => {
    const media = await startMedia();
    const listenOnly = await member(media, {
      email: 'so-ouve@example.com',
      topics: ['hermetismo'],
      features: ['search', 'media'],
    });
    const libraryOnly = await member(media, {
      email: 'so-biblioteca@example.com',
      topics: ['hermetismo'],
      features: ['search', 'media-library'],
    });
    const both = await member(media, {
      email: 'biblioteca@example.com',
      topics: ['hermetismo'],
      features: LISTENER,
    });
    for (const url of [LIBRARY, HOME]) {
      expect((await listenOnly.call('GET', url)).statusCode).toBe(403);
      expect((await libraryOnly.call('GET', url)).statusCode).toBe(403);
      expect((await both.call('GET', url)).statusCode).toBe(200);
    }
    const id = randomUUID();
    expect(
      (
        await listenOnly.call('PUT', '/api/v1/media/played', {
          ids: [id],
          played: true,
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (await listenOnly.call('DELETE', `${LIBRARY}/recents`)).statusCode,
    ).toBe(403);
  });

  it('is open to masters, who have every feature', async () => {
    const media = await startMedia();
    expect((await media.owner('GET', LIBRARY)).statusCode).toBe(200);
  });
});

describe('Media library: what each person sees (BR-2, NFR-3)', () => {
  it('lists only the collections the person sees, in items, chips and home (AC-5)', async () => {
    const media = await startMedia();
    const seen = await ready(media, { title: 'Aula do Hermetismo' });
    const hidden = await ready(media, {
      title: 'Aula de Alquimia',
      topic: 'alquimia',
    });
    const person = await member(media, {
      email: 'hermetismo@example.com',
      topics: ['hermetismo'],
      features: LISTENER,
    });
    await playedAt(media, media.owner, {
      id: hidden,
      positionMs: 10_000,
      at: '2026-11-01T10:00:00.000Z',
    });

    const page = (await person.call('GET', LIBRARY)).json();
    expect(page.items.map((item: LibraryItem) => item.id)).toEqual([seen]);
    expect(page.facets.topics).toEqual(['hermetismo']);
    expect(page.total).toBe(1);
    const asked = (
      await person.call('GET', `${LIBRARY}?topic=alquimia`)
    ).json();
    expect(asked.items).toEqual([]);
    const home = (await person.call('GET', HOME)).json();
    expect(home.continueListening).toEqual([]);
    expect(home.recentlyPlayed).toEqual([]);

    const owner = (await media.owner('GET', LIBRARY)).json();
    expect(owner.facets.topics).toEqual(['alquimia', 'hermetismo']);
  });

  it('keeps one person’s positions out of another’s library (NFR-3)', async () => {
    const media = await startMedia();
    const id = await ready(media, { title: 'Palestra compartilhada' });
    const first = await member(media, {
      email: 'primeira@example.com',
      topics: ['hermetismo'],
      features: LISTENER,
    });
    const second = await member(media, {
      email: 'segunda@example.com',
      topics: ['hermetismo'],
      features: LISTENER,
    });
    await playedAt(media, first.call, {
      id,
      positionMs: 42_000,
      at: '2026-11-01T10:00:00.000Z',
    });
    const mine = (await first.call('GET', HOME)).json();
    expect(titles(mine.continueListening)).toEqual(['Palestra compartilhada']);
    const theirs = (await second.call('GET', HOME)).json();
    expect(theirs.continueListening).toEqual([]);
    expect(theirs.recentlyPlayed).toEqual([]);
    const item = (await second.call('GET', LIBRARY)).json().items[0];
    expect(item).toMatchObject({ positionMs: 0, lastPlayedAt: null });
  });

  it('shows a media being converted only to who sent it and to masters (AC-13)', async () => {
    const media = await startMedia();
    const sender = await member(media, {
      email: 'envia@example.com',
      topics: ['hermetismo'],
      features: [...LISTENER, 'media-upload'],
    });
    const other = await member(media, {
      email: 'outro@example.com',
      topics: ['hermetismo'],
      features: LISTENER,
    });
    const created = await sender.call(
      'POST',
      '/api/v1/topics/hermetismo/media',
      aRequest({ title: 'Em conversão' }),
    );
    const id: string = created.json().id;
    expect(
      (await upload(media, { id, body: AUDIO, headers: sender.headers }))
        .statusCode,
    ).toBe(200);
    withDb(media, (db) =>
      db
        .prepare(
          "UPDATE media SET status = 'processing', progress = 40 WHERE id = ?",
        )
        .run(id),
    );

    expect((await other.call('GET', LIBRARY)).json().items).toEqual([]);
    const own = (await sender.call('GET', LIBRARY)).json().items;
    expect(own).toMatchObject([{ id, status: 'processing', progress: 40 }]);
    expect((await media.owner('GET', LIBRARY)).json().items).toHaveLength(1);
  });
});

describe('Media library: home (FR-2, BR-3, BR-4)', () => {
  it('lists in-progress media, the most recently played first, with the video kind (AC-3)', async () => {
    const media = await startMedia();
    const older = await ready(media, { title: 'Mais antiga' });
    const video = await ready(media, { title: 'Vídeo do meio' });
    const newest = await ready(media, { title: 'Mais recente' });
    const heard = await ready(media, { title: 'Já ouvida' });
    withDb(media, (db) =>
      db.prepare("UPDATE media SET kind = 'video' WHERE id = ?").run(video),
    );
    await playedAt(media, media.owner, {
      id: older,
      positionMs: 10_000,
      at: '2026-11-01T10:00:00.000Z',
    });
    await playedAt(media, media.owner, {
      id: video,
      positionMs: 20_000,
      at: '2026-11-02T10:00:00.000Z',
    });
    await playedAt(media, media.owner, {
      id: newest,
      positionMs: 30_000,
      at: '2026-11-03T10:00:00.000Z',
    });
    await playedAt(media, media.owner, {
      id: heard,
      positionMs: 179_000,
      at: '2026-11-03T11:00:00.000Z',
    });

    const home = (await media.owner('GET', HOME)).json();
    expect(titles(home.continueListening)).toEqual([
      'Mais recente',
      'Vídeo do meio',
      'Mais antiga',
    ]);
    expect(home.continueListening[1]).toMatchObject({
      kind: 'video',
      positionMs: 20_000,
    });
    expect(titles(home.recentlyPlayed)).toEqual([
      'Já ouvida',
      'Mais recente',
      'Vídeo do meio',
      'Mais antiga',
    ]);
  });

  it('empties the recents on "Limpar recentes" and keeps positions (AC-9)', async () => {
    const media = await startMedia();
    const id = await ready(media, { title: 'Em andamento' });
    await playedAt(media, media.owner, {
      id,
      positionMs: 50_000,
      at: '2026-11-01T10:00:00.000Z',
    });
    const cleared = await media.owner('DELETE', `${LIBRARY}/recents`);
    expect(cleared.statusCode).toBe(204);

    const home = (await media.owner('GET', HOME)).json();
    expect(home.recentlyPlayed).toEqual([]);
    expect(home.recentsClearedAt).not.toBeNull();
    expect(titles(home.continueListening)).toEqual(['Em andamento']);
    expect(
      (await media.owner('GET', `/api/v1/media/${id}`)).json().positionMs,
    ).toBe(50_000);

    // Played again after clearing: back in the recents.
    await media.owner('PUT', `/api/v1/media/${id}/progress`, {
      positionMs: 60_000,
      basedOn: (await media.owner('GET', `/api/v1/media/${id}`)).json()
        .positionUpdatedAt,
    });
    expect(
      titles((await media.owner('GET', HOME)).json().recentlyPlayed),
    ).toEqual(['Em andamento']);
  });
});

describe('Media library: marking (FR-3, BR-5)', () => {
  it('marks two as heard and then one as not heard (AC-7, AC-8)', async () => {
    const media = await startMedia();
    const playing = await ready(media, { title: 'Em andamento' });
    const fresh = await ready(media, { title: 'Nova' });
    await playedAt(media, media.owner, {
      id: playing,
      positionMs: 70_000,
      at: '2026-11-01T10:00:00.000Z',
    });

    const marked = await media.owner('PUT', '/api/v1/media/played', {
      ids: [playing, fresh, playing],
      played: true,
    });
    expect(marked.statusCode).toBe(200);
    expect(marked.json()).toEqual({ applied: [playing, fresh] });
    for (const id of [playing, fresh]) {
      const item = (await media.owner('GET', `/api/v1/media/${id}`)).json();
      expect(item.positionMs).toBe(0);
      expect(item.completedAt).not.toBeNull();
    }
    const home = (await media.owner('GET', HOME)).json();
    expect(home.continueListening).toEqual([]);
    // Marking is not playing: only the media actually played is in the recents.
    expect(titles(home.recentlyPlayed)).toEqual(['Em andamento']);

    const unmarked = await media.owner('PUT', '/api/v1/media/played', {
      ids: [playing],
      played: false,
    });
    expect(unmarked.json()).toEqual({ applied: [playing] });
    expect(
      (await media.owner('GET', `/api/v1/media/${playing}`)).json(),
    ).toMatchObject({ positionMs: 0, completedAt: null });
  });

  it('skips, with 200, a media the person does not see and changes nothing in it (AC-11)', async () => {
    const media = await startMedia();
    const hidden = await ready(media, {
      title: 'Fora do alcance',
      topic: 'alquimia',
    });
    const seen = await ready(media, { title: 'Ao alcance' });
    const person = await member(media, {
      email: 'marca@example.com',
      topics: ['hermetismo'],
      features: LISTENER,
    });
    const missing = randomUUID();
    const marked = await person.call('PUT', '/api/v1/media/played', {
      ids: [hidden, missing, seen],
      played: true,
    });
    expect(marked.statusCode).toBe(200);
    expect(marked.json()).toEqual({ applied: [seen] });
    const rows = withDb(media, (db) =>
      db
        .prepare('SELECT COUNT(*) AS n FROM media_progress WHERE media_id = ?')
        .get(hidden),
    );
    expect(Number(rows?.['n'])).toBe(0);
  });

  it('refuses an empty list and more than 200 ids', async () => {
    const media = await startMedia();
    for (const ids of [[], Array.from({ length: 201 }, () => randomUUID())]) {
      const refused = await media.owner('PUT', '/api/v1/media/played', {
        ids,
        played: true,
      });
      expect(refused.statusCode).toBe(400);
    }
  });
});

describe('Media library: filters, search, sort and pages (FR-1, BR-6)', () => {
  it('narrows by kind and state together and counts (AC-6)', async () => {
    const media = await startMedia();
    const videos = [
      await ready(media, { title: 'Vídeo um' }),
      await ready(media, { title: 'Vídeo dois' }),
      await ready(media, { title: 'Vídeo três' }),
    ];
    const audio = await ready(media, { title: 'Áudio em andamento' });
    withDb(media, (db) =>
      db
        .prepare("UPDATE media SET kind = 'video' WHERE id IN (?, ?, ?)")
        .run(...videos),
    );
    for (const id of [videos[0], videos[1], audio])
      if (id)
        await playedAt(media, media.owner, {
          id,
          positionMs: 5_000,
          at: '2026-11-01T10:00:00.000Z',
        });

    const page = (
      await media.owner('GET', `${LIBRARY}?kind=video&state=in-progress`)
    ).json();
    expect(page.total).toBe(2);
    expect(titles(page.items).sort()).toEqual(['Vídeo dois', 'Vídeo um']);
    expect(page.totalDurationMs).toBe(360_000);
    expect(page.facets.kinds).toEqual(['audio', 'video']);
    expect(page.facets.states).toEqual(['in-progress', 'unheard']);
  });

  it('finds by title or author, without accents, and finds nothing for an absent word (AC-12)', async () => {
    const media = await startMedia();
    await ready(media, {
      title: 'Ensino do Mestre',
      authorship: 'mestre-laercio',
    });
    await ready(media, { title: 'Palestra sobre Hermes' });
    const byAuthor = (await media.owner('GET', `${LIBRARY}?q=LAÉRCIO`)).json();
    expect(titles(byAuthor.items)).toEqual(['Ensino do Mestre']);
    const byTitle = (await media.owner('GET', `${LIBRARY}?q=hermes`)).json();
    expect(titles(byTitle.items)).toEqual(['Palestra sobre Hermes']);
    const none = (await media.owner('GET', `${LIBRARY}?q=conselheira`)).json();
    expect(none).toMatchObject({ items: [], total: 0 });
  });

  it('refuses an unknown chip or order with 400', async () => {
    const media = await startMedia();
    expect(
      (await media.owner('GET', `${LIBRARY}?kind=podcast`)).statusCode,
    ).toBe(400);
    expect(
      (await media.owner('GET', `${LIBRARY}?sort=random`)).statusCode,
    ).toBe(400);
  });

  it('pages 50 at a time with a cursor, without repeating an item', async () => {
    const media = await startMedia();
    seedMedia(media, 120);
    const first = (await media.owner('GET', `${LIBRARY}?sort=title`)).json();
    expect(first.items).toHaveLength(50);
    expect(first.total).toBe(120);
    const second = (
      await media.owner(
        'GET',
        `${LIBRARY}?sort=title&cursor=${first.nextCursor}`,
      )
    ).json();
    const third = (
      await media.owner(
        'GET',
        `${LIBRARY}?sort=title&cursor=${second.nextCursor}`,
      )
    ).json();
    expect(third.items).toHaveLength(20);
    expect(third.nextCursor).toBeNull();
    const ids = [...first.items, ...second.items, ...third.items].map(
      (item: LibraryItem) => item.id,
    );
    expect(new Set(ids).size).toBe(120);
  });
});

describe('Media library: choices in the account (FR-5, BR-7)', () => {
  it('keeps the library’s order, view and filters apart from the player’s (AC-10)', async () => {
    const media = await startMedia();
    const saved = await media.owner('PUT', '/api/v1/media/preferences', {
      librarySort: 'duration',
      libraryView: 'grid',
      libraryFilters: {
        kinds: [],
        states: ['in-progress'],
        authorships: [],
        topic: 'hermetismo',
      },
    });
    expect(saved.statusCode).toBe(200);
    // The player saves only its own fields: the library's stay.
    await media.owner('PUT', '/api/v1/media/preferences', { speed: 1.5 });
    expect(
      (await media.owner('GET', '/api/v1/media/preferences')).json(),
    ).toEqual({
      speed: 1.5,
      showRemaining: true,
      skipBackSec: 15,
      skipForwardSec: 30,
      librarySort: 'duration',
      libraryView: 'grid',
      libraryFilters: {
        kinds: [],
        states: ['in-progress'],
        authorships: [],
        topic: 'hermetismo',
      },
    });
  });

  it('refuses an empty update or an unknown view', async () => {
    const media = await startMedia();
    for (const body of [{}, { libraryView: 'carousel' }])
      expect(
        (await media.owner('PUT', '/api/v1/media/preferences', body))
          .statusCode,
      ).toBe(400);
  });
});

/** NFR-1's p95 bound for GET /media/library with 2 000 media in 10 collections. */
const P95_BOUND_MS = 300;

describe('Media library: speed (NFR-1)', () => {
  it('answers the library of 2 000 media within 300 ms at p95', async () => {
    const media = await startMedia();
    seedMedia(media, 2_000);
    const timings: number[] = [];
    for (let run = 0; run < 20; run++) {
      const started = performance.now();
      const answer = await media.owner(
        'GET',
        `${LIBRARY}?state=unheard&sort=title&q=palestra`,
      );
      timings.push(performance.now() - started);
      expect(answer.statusCode).toBe(200);
      expect(answer.json().total).toBe(2_000);
    }
    timings.sort((a, b) => a - b);
    const p95 = timings[Math.ceil(timings.length * 0.95) - 1] ?? Infinity;
    expect(p95).toBeLessThanOrEqual(P95_BOUND_MS);
  });
});

/** Ready media written straight to the database: two collections, as the masters see. */
function seedMedia(media: Media, count: number): void {
  withDb(media, (db) => {
    const insert = db.prepare(
      `INSERT INTO media (id, topic, title, authorship, owner_principal, file_name,
         upload_bytes, status, duration_ms, bytes, created_at, updated_at)
       VALUES (?, ?, ?, 'outros-autores', 'seed', 'a.mp3', 1, 'ready', ?, 1, ?, ?)`,
    );
    db.exec('BEGIN');
    for (let n = 0; n < count; n++) {
      const at = new Date(Date.UTC(2026, 0, 1) + n * 60_000).toISOString();
      insert.run(
        randomUUID(),
        n % 2 === 0 ? 'hermetismo' : 'alquimia',
        `Palestra ${String(n).padStart(4, '0')}`,
        (n % 90) * 60_000,
        at,
        at,
      );
    }
    db.exec('COMMIT');
  });
}
