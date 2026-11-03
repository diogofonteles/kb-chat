import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { applyMigrations } from './media-database.js';
import { MEDIA_MIGRATIONS } from './media-migrations.js';
import { SqliteMediaStore } from './sqlite-media-store.js';

/** This item's migration, found by name: its number may change on a rebase (KBC-036). */
const AUTHOR_MIGRATION = MEDIA_MIGRATIONS.find(
  (one) => one.name === 'media-author',
);
if (!AUTHOR_MIGRATION) throw new Error('no media-author migration');
const AUTHOR_VERSION = AUTHOR_MIGRATION.version;
const BEFORE_AUTHORS = MEDIA_MIGRATIONS.filter(
  (one) => one.version < AUTHOR_VERSION,
);
/** Up to this migration: later ones (KBC-064's diarization) are not what it proves. */
const THROUGH_AUTHORS = MEDIA_MIGRATIONS.filter(
  (one) => one.version <= AUTHOR_VERSION,
);

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

    expect(applyMigrations(db, THROUGH_AUTHORS)).toEqual([AUTHOR_VERSION]);

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

  it('keeps the Mestre on a row an older image wrote after the migration (rollback, ADR 0030 §4)', () => {
    const db = databaseOfToday();
    applyMigrations(db, MEDIA_MIGRATIONS);
    const at = '2026-11-04T12:00:00.000Z';
    db.prepare(
      `INSERT INTO media (id, topic, title, authorship, owner_principal, file_name,
         upload_bytes, status, created_at, updated_at)
       VALUES ('c', 'hermetismo', 'Enviada no rollback', 'mestre-laercio', 'owner',
         'c.mp3', 10, 'ready', ?, ?)`,
    ).run(at, at);

    const store = new SqliteMediaStore(db);

    expect(store.getMedia('c')?.author).toBe('mestre-laercio');
    expect(store.getMedia('b')?.author).toBeNull();
  });

  it('refuses to start when a version was applied under another name (a renumbering drift)', () => {
    const db = new DatabaseSync(':memory:');
    applyMigrations(db, MEDIA_MIGRATIONS);
    const drifted = MEDIA_MIGRATIONS.map((one) =>
      one.version === AUTHOR_VERSION ? { ...one, name: 'transcription' } : one,
    );

    expect(() => applyMigrations(db, drifted)).toThrow(
      `Media migration ${AUTHOR_VERSION} was applied as "media-author", not "transcription"`,
    );
  });
});
