import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { closeApp } from '../test/ai-app-harness.js';
import {
  inTransaction,
  openMediaDatabase,
} from './adapters/sqlite/media-database.js';
import { MEDIA_MIGRATIONS } from './adapters/sqlite/media-migrations.js';
import { SqliteBookmarkStore } from './adapters/sqlite/sqlite-bookmark-store.js';
import {
  member,
  queuedItem,
  readyItem,
  startMedia,
  type Media,
} from '../test/media-harness.js';

afterEach(closeApp);

/** The fake worker converts every upload to 180 s (media-harness `convert`). */
const DURATION_MS = 180_000;

const listenerGrant = {
  email: 'ouvinte@example.com',
  topics: ['hermetismo'],
  features: ['search', 'media'],
};

async function personId(media: Media, email: string): Promise<string> {
  const people = (await media.owner('GET', '/api/v1/people')).json().items as {
    id: string;
    email: string;
  }[];
  const found = people.find((person) => person.email === email);
  if (!found) throw new Error(`no person ${email}`);
  return found.id;
}

describe('Media bookmarks (KBC-042 FR-1)', () => {
  it('creates, lists by position, edits and deletes the person’s bookmarks', async () => {
    const media = await startMedia();
    const item = await readyItem(media);
    const url = `/api/v1/media/${item.id}/bookmarks`;
    const late = randomUUID();
    const created = await media.owner('POST', url, {
      id: late,
      positionMs: 120_000,
      note: '  lei do ritmo ',
    });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({
      id: late,
      mediaId: item.id,
      positionMs: 120_000,
      note: 'lei do ritmo',
    });
    const early = randomUUID();
    expect(
      (await media.owner('POST', url, { id: early, positionMs: 1_000 }))
        .statusCode,
    ).toBe(201);
    const listed = (await media.owner('GET', url)).json().items;
    expect(listed.map((b: { id: string }) => b.id)).toEqual([early, late]);
    expect(listed[0].note).toBeNull();

    const edited = await media.owner('PATCH', `${url}/${early}`, {
      note: 'polaridade',
    });
    expect(edited.statusCode).toBe(200);
    expect(edited.json().note).toBe('polaridade');
    expect(
      (await media.owner('PATCH', `${url}/${early}`, { note: null })).json()
        .note,
    ).toBeNull();

    expect((await media.owner('DELETE', `${url}/${late}`)).statusCode).toBe(
      204,
    );
    expect((await media.owner('DELETE', `${url}/${late}`)).statusCode).toBe(
      404,
    );
    expect(
      (await media.owner('GET', url))
        .json()
        .items.map((b: { id: string }) => b.id),
    ).toEqual([early]);
  });

  it('gives the same bookmark back when it is sent again (a retry never doubles it)', async () => {
    const media = await startMedia();
    const item = await readyItem(media);
    const url = `/api/v1/media/${item.id}/bookmarks`;
    const id = randomUUID();
    const first = await media.owner('POST', url, { id, positionMs: 5_000 });
    const again = await media.owner('POST', url, { id, positionMs: 5_000 });
    expect(again.statusCode).toBe(200);
    expect(again.json()).toEqual(first.json());
    expect((await media.owner('GET', url)).json().items).toHaveLength(1);
  });

  it('refuses a position past the end, a long note and an id taken elsewhere', async () => {
    const media = await startMedia();
    const item = await readyItem(media);
    const other = await readyItem(media);
    const url = `/api/v1/media/${item.id}/bookmarks`;
    const past = await media.owner('POST', url, {
      id: randomUUID(),
      positionMs: DURATION_MS + 1,
    });
    expect(past.statusCode).toBe(400);
    expect(past.json().error.code).toBe('VALIDATION_FAILED');
    expect(
      (
        await media.owner('POST', url, {
          id: randomUUID(),
          positionMs: 0,
          note: 'a'.repeat(2_001),
        })
      ).statusCode,
    ).toBe(400);
    const id = randomUUID();
    await media.owner('POST', url, { id, positionMs: 0 });
    const taken = await media.owner(
      'POST',
      `/api/v1/media/${other.id}/bookmarks`,
      { id, positionMs: 0 },
    );
    // Taken elsewhere: answered as unknown, telling nothing about it.
    expect(taken.statusCode).toBe(404);
    // A blank note is no note.
    const blank = await media.owner('PATCH', `${url}/${id}`, { note: '   ' });
    expect(blank.statusCode).toBe(200);
    expect(blank.json().note).toBeNull();
  });

  it('keeps bookmarks out of a media that is not ready, or unknown', async () => {
    const media = await startMedia();
    const unknown = `/api/v1/media/${randomUUID()}/bookmarks`;
    expect((await media.owner('GET', unknown)).statusCode).toBe(404);
    expect(
      (await media.owner('POST', unknown, { id: randomUUID(), positionMs: 0 }))
        .statusCode,
    ).toBe(404);
    const queued = await queuedItem(media);
    // Still converting: no length yet, so any position may wait for it.
    expect(
      (
        await media.owner('POST', `/api/v1/media/${queued.id}/bookmarks`, {
          id: randomUUID(),
          positionMs: 0,
        })
      ).statusCode,
    ).toBe(201);
  });

  it('answers 404 to anyone touching another person’s bookmark, and changes nothing (AC-4, BR-1)', async () => {
    const media = await startMedia();
    const item = await readyItem(media);
    const listener = await member(media, listenerGrant);
    const url = `/api/v1/media/${item.id}/bookmarks`;
    const id = randomUUID();
    await media.owner('POST', url, { id, positionMs: 9_000, note: 'minha' });
    expect(
      (await listener.call('PATCH', `${url}/${id}`, { note: 'roubada' }))
        .statusCode,
    ).toBe(404);
    expect((await listener.call('DELETE', `${url}/${id}`)).statusCode).toBe(
      404,
    );
    expect((await listener.call('GET', url)).json().items).toEqual([]);
    expect(
      (await listener.call('GET', '/api/v1/media/bookmarks')).json().items,
    ).toEqual([]);
    expect((await media.owner('GET', url)).json().items).toMatchObject([
      { id, note: 'minha' },
    ]);
  });

  it('needs "Ouvir mídia"', async () => {
    const media = await startMedia();
    const item = await readyItem(media);
    const reader = await member(media, {
      email: 'leitor@example.com',
      topics: ['hermetismo'],
      features: ['search'],
    });
    expect(
      (await reader.call('GET', `/api/v1/media/${item.id}/bookmarks`))
        .statusCode,
    ).toBe(403);
    expect(
      (await reader.call('GET', '/api/v1/media/bookmarks')).statusCode,
    ).toBe(403);
  });
});

/**
 * Seeds `count` bookmarks for the owner of `firstId` on its media in one transaction, through
 * the store the API itself writes with: a thousand HTTP calls took seconds under load.
 */
function seedBookmarks(media: Media, firstId: string, count: number): void {
  const db = openMediaDatabase(
    join(media.mediaDir, 'media.db'),
    MEDIA_MIGRATIONS,
  );
  try {
    const store = new SqliteBookmarkStore(db);
    const first = store.bookmark(firstId);
    if (!first) throw new Error(`no bookmark ${firstId}`);
    inTransaction(db, () => {
      for (let i = 0; i < count; i++)
        store.addBookmark({
          principal: first.principal,
          bookmark: { ...first, id: randomUUID(), positionMs: i + 1 },
        });
    });
  } finally {
    db.close();
  }
}

describe('Media bookmarks: the cap', () => {
  it('keeps at most 1 000 per person and media, and says so (BOOKMARK_LIMIT)', async () => {
    const media = await startMedia();
    const item = await readyItem(media);
    const url = `/api/v1/media/${item.id}/bookmarks`;
    const first = randomUUID();
    expect(
      (await media.owner('POST', url, { id: first, positionMs: 0 })).statusCode,
    ).toBe(201);
    seedBookmarks(media, first, 998);
    // The thousandth still fits; the cap is checked by the API on each create.
    expect(
      (await media.owner('POST', url, { id: randomUUID(), positionMs: 999 }))
        .statusCode,
    ).toBe(201);
    expect(
      (await media.owner('GET', url)).json().items as unknown[],
    ).toHaveLength(1_000);
    const over = await media.owner('POST', url, {
      id: randomUUID(),
      positionMs: 0,
    });
    expect(over.statusCode).toBe(409);
    expect(over.json().error).toMatchObject({
      code: 'BOOKMARK_LIMIT',
      details: { limit: 1_000 },
    });
    // Another person still has their own room.
    const listener = await member(media, listenerGrant);
    expect(
      (await listener.call('POST', url, { id: randomUUID(), positionMs: 0 }))
        .statusCode,
    ).toBe(201);
  });
});

describe('Media bookmarks: "Meus marcadores" (KBC-042 FR-5)', () => {
  it('lists the person’s bookmarks in every media, newest first, with the media', async () => {
    const media = await startMedia();
    const first = await readyItem(media);
    const second = await readyItem(media);
    const a = randomUUID();
    const b = randomUUID();
    await media.owner('POST', `/api/v1/media/${first.id}/bookmarks`, {
      id: a,
      positionMs: 1_000,
    });
    await media.owner('POST', `/api/v1/media/${second.id}/bookmarks`, {
      id: b,
      positionMs: 2_000,
      note: 'nota',
    });
    const mine = (await media.owner('GET', '/api/v1/media/bookmarks')).json()
      .items;
    expect(mine.map((x: { id: string }) => x.id)).toEqual([b, a]);
    expect(mine[0]).toMatchObject({
      mediaId: second.id,
      mediaTitle: second.title,
      mediaDurationMs: DURATION_MS,
      note: 'nota',
    });
  });

  it('hides them while the person cannot see the collection, and shows them again (AC-5, BR-4)', async () => {
    const media = await startMedia();
    const item = await readyItem(media);
    const listener = await member(media, listenerGrant);
    const id = randomUUID();
    await listener.call('POST', `/api/v1/media/${item.id}/bookmarks`, {
      id,
      positionMs: 3_000,
    });
    const person = await personId(media, listenerGrant.email);
    await media.owner('PATCH', `/api/v1/people/${person}`, { topics: [] });
    expect(
      (await listener.call('GET', '/api/v1/media/bookmarks')).json().items,
    ).toEqual([]);
    expect(
      (await listener.call('GET', `/api/v1/media/${item.id}/bookmarks`))
        .statusCode,
    ).toBe(404);
    await media.owner('PATCH', `/api/v1/people/${person}`, {
      topics: ['hermetismo'],
    });
    expect(
      (await listener.call('GET', '/api/v1/media/bookmarks')).json().items,
    ).toMatchObject([{ id }]);
  });

  it('removing a media removes its bookmarks from the database (AC-6, BR-3)', async () => {
    const media = await startMedia();
    const item = await readyItem(media);
    await media.owner('POST', `/api/v1/media/${item.id}/bookmarks`, {
      id: randomUUID(),
      positionMs: 1_000,
    });
    const count = () => {
      const db = new DatabaseSync(join(media.mediaDir, 'media.db'), {
        readOnly: true,
      });
      const n = db
        .prepare('SELECT COUNT(*) AS n FROM media_bookmarks WHERE media_id = ?')
        .get(item.id)?.['n'];
      db.close();
      return Number(n);
    };
    expect(count()).toBe(1);
    expect(
      (await media.owner('DELETE', `/api/v1/media/${item.id}`)).statusCode,
    ).toBe(204);
    expect(count()).toBe(0);
    expect(
      (await media.owner('GET', '/api/v1/media/bookmarks')).json().items,
    ).toEqual([]);
  });
});
