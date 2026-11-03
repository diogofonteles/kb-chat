import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { applyMigrations } from './media-database.js';
import { MEDIA_MIGRATIONS } from './media-migrations.js';
import { SqliteMediaStore } from './sqlite-media-store.js';

const BEFORE_AUTHORS = MEDIA_MIGRATIONS.filter((one) => one.version < 5);

/** A media database as it was before KBC-049, with one item of each authorship. */
function databaseOfToday(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  applyMigrations(db, BEFORE_AUTHORS);
  const insert = db.prepare(
    `INSERT INTO media (id, topic, title, authorship, owner_principal, file_name,
       upload_bytes, status, created_at, updated_at)
     VALUES (?, 'hermetismo', ?, ?, 'owner', 'a.mp3', 10, 'ready', ?, ?)`,
  );
  const at = '2026-10-30T12:00:00.000Z';
  insert.run('a', 'Palestra do Mestre', 'mestre-laercio', at, at);
  insert.run('b', 'Palestra de outro', 'outros-autores', at, at);
  return db;
}

describe('the media-author migration (KBC-049 FR-5, AC-5)', () => {
  it("turns the Mestre's media into his author id and the others into no author, losing nothing", () => {
    const db = databaseOfToday();

    expect(applyMigrations(db, MEDIA_MIGRATIONS)).toEqual([5]);

    const rows = db
      .prepare('SELECT id, title, author, authorship FROM media ORDER BY id')
      .all()
      .map((row) => ({ ...row }));
    expect(rows).toEqual([
      {
        id: 'a',
        title: 'Palestra do Mestre',
        author: 'mestre-laercio',
        authorship: 'mestre-laercio',
      },
      {
        id: 'b',
        title: 'Palestra de outro',
        author: null,
        authorship: 'outros-autores',
      },
    ]);
    const store = new SqliteMediaStore(db);
    expect(store.topicsWithAuthor('mestre-laercio')).toEqual(['hermetismo']);
  });

  it('is applied once: a second start changes nothing', () => {
    const db = databaseOfToday();
    applyMigrations(db, MEDIA_MIGRATIONS);

    expect(applyMigrations(db, MEDIA_MIGRATIONS)).toEqual([]);
  });
});
