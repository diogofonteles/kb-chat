import { describe, expect, it } from 'vitest';
import { openMediaDatabase } from './adapters/sqlite/media-database.js';
import { MEDIA_MIGRATIONS } from './adapters/sqlite/media-migrations.js';
import { SqliteListeningStore } from './adapters/sqlite/sqlite-listening-store.js';
import { SqliteMediaStore } from './adapters/sqlite/sqlite-media-store.js';
import type { MediaFilesPort } from './ports/media-files.js';
import {
  MediaService,
  type MediaActor,
} from './modules/media/media-service.js';

/**
 * /midia lists each recording with its tracks (v2 media-list): the tracks of a page come in
 * one read, and their progress in one more, however many recordings it has (ND-19).
 */

const AT = '2026-11-19T12:00:00.000Z';
const RECORDINGS = 5;
const TRACKS_EACH = 3;

const OWNER: MediaActor = {
  principal: 'owner@example.com',
  isMaster: true,
  canUpload: true,
  quotaBytes: null,
  seesTracks: true,
  canSee: () => true,
  levelsIn: () => null,
};

/** Counts how often each method of `target` is called. */
function counted<T extends object>(target: T) {
  const calls = new Map<string, number>();
  const proxy = new Proxy(target, {
    get(object, key, receiver) {
      const value: unknown = Reflect.get(object, key, receiver);
      if (typeof value !== 'function') return value;
      return (...args: unknown[]) => {
        calls.set(String(key), (calls.get(String(key)) ?? 0) + 1);
        return Reflect.apply(value, object, args);
      };
    },
  });
  return { proxy, calls: (name: string) => calls.get(name) ?? 0 };
}

function aLibrary() {
  const db = openMediaDatabase(':memory:', MEDIA_MIGRATIONS);
  const insert = db.prepare(
    `INSERT INTO media (id, topic, title, authorship, owner_principal, file_name,
       upload_bytes, status, duration_ms, bytes, created_at, updated_at,
       parent_media_id, parent_start_ms, parent_end_ms, track_ordinal)
     VALUES (?, 'hermetismo', ?, 'outros-autores', 'seed', 'a.mp3', 1, 'ready', 180000, 1,
       ?, ?, ?, ?, ?, ?)`,
  );
  for (let r = 0; r < RECORDINGS; r++) {
    const created = `2026-11-${String(10 + r).padStart(2, '0')}T12:00:00.000Z`;
    insert.run(
      `rec-${r}`,
      `Palestra ${r}`,
      created,
      AT,
      null,
      null,
      null,
      null,
    );
    // Out of order on purpose: the list gives them in their order.
    for (const t of [2, 0, 1].slice(0, TRACKS_EACH))
      insert.run(
        `rec-${r}-t${t}`,
        `Faixa ${r}.${t}`,
        AT,
        AT,
        `rec-${r}`,
        t * 60_000,
        (t + 1) * 60_000,
        t + 1,
      );
  }
  const store = counted(new SqliteMediaStore(db));
  const listening = counted(new SqliteListeningStore(db));
  const service = new MediaService({
    store: store.proxy,
    files: {} as MediaFilesPort,
    listening: listening.proxy,
    hasTopic: () => true,
    authorOf: () => null,
  });
  return { service, store, listening };
}

describe('MediaService.list with tracks (v2 media-list, ND-19)', () => {
  it('reads the tracks of every recording at once, and their progress once', () => {
    const { service, store, listening } = aLibrary();

    const items = service.list(OWNER, 'hermetismo');

    expect(items.map((item) => item.id)).toEqual([
      'rec-4',
      'rec-3',
      'rec-2',
      'rec-1',
      'rec-0',
    ]);
    expect(items[0]?.tracks.map((track) => track.title)).toEqual([
      'Faixa 4.0',
      'Faixa 4.1',
      'Faixa 4.2',
    ]);
    expect(store.calls('listTracksOf')).toBe(1);
    // The recordings' progress and the tracks' progress: two reads, not one per recording.
    expect(listening.calls('progressOf')).toBe(2);
  });

  it('reads no tracks for whoever has no media-tracks', () => {
    const { service, store } = aLibrary();

    const items = service.list({ ...OWNER, seesTracks: false }, 'hermetismo');

    expect(items.every((item) => item.tracks.length === 0)).toBe(true);
    expect(store.calls('listTracksOf')).toBe(0);
  });
});
