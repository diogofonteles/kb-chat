import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { applyMigrations } from './media-database.js';
import { MEDIA_MIGRATIONS } from './media-migrations.js';
import { SqliteListeningStore } from './sqlite-listening-store.js';

const FIRST = '33333333-3333-4333-8333-333333333333';
const SECOND = '44444444-4444-4444-8444-444444444444';
const MISSING = '55555555-5555-4555-8555-555555555555';
const NOW = new Date('2026-11-03T10:00:00.000Z');

const progressOf = (mediaId: string, completedAt: string | null = null) => ({
  mediaId,
  progress: { positionMs: 0, completedAt },
  now: NOW,
});

describe('SqliteListeningStore.markMany (KBC-051 FR-3)', () => {
  let db: DatabaseSync;
  let store: SqliteListeningStore;

  beforeEach(() => {
    db = new DatabaseSync(':memory:');
    db.exec('PRAGMA foreign_keys = ON');
    applyMigrations(db, MEDIA_MIGRATIONS);
    const insert = db.prepare(
      `INSERT INTO media (id, topic, title, authorship, owner_principal, file_name,
         upload_bytes, status, created_at, updated_at)
       VALUES (?, 'hermetismo', 'Aula', 'outros-autores', 'p', 'a.mp3', 1, 'ready', ?, ?)`,
    );
    for (const id of [FIRST, SECOND])
      insert.run(id, NOW.toISOString(), NOW.toISOString());
    store = new SqliteListeningStore(db);
  });

  afterEach(() => db.close());

  it('saves every mark without counting any as played', () => {
    const heardAt = NOW.toISOString();
    store.markMany({
      principal: 'p',
      marks: [progressOf(FIRST, heardAt), progressOf(SECOND, heardAt)],
    });

    const saved = store.allProgressOf('p');
    expect(saved.get(FIRST)?.completedAt).toBe(heardAt);
    expect(saved.get(SECOND)?.completedAt).toBe(heardAt);
    expect(saved.get(SECOND)?.playedAt).toBeNull();
  });

  it('saves none when one of them fails (all or nothing)', () => {
    expect(() =>
      store.markMany({
        principal: 'p',
        marks: [progressOf(FIRST), progressOf(MISSING)],
      }),
    ).toThrow(/FOREIGN KEY/);

    expect(store.allProgressOf('p').size).toBe(0);
  });
});
