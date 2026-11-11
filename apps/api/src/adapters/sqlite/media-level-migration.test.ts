import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { applyMigrations } from './media-database.js';
import { MEDIA_MIGRATIONS } from './media-migrations.js';
import { SqliteMediaStore } from './sqlite-media-store.js';

/** This item's migration, found by name: its number may change on a rebase. */
const LEVEL_MIGRATION = MEDIA_MIGRATIONS.find(
  (one) => one.name === 'media-level',
);
if (!LEVEL_MIGRATION) throw new Error('no media-level migration');
const VERSION = LEVEL_MIGRATION.version;
const BEFORE = MEDIA_MIGRATIONS.filter((one) => one.version < VERSION);

const AT = '2026-11-10T12:00:00.000Z';

/** A media database as it is today, with `rows` ready audios in `hermetismo`. */
function databaseOfToday(rows: number): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  applyMigrations(db, BEFORE);
  const insert = db.prepare(
    `INSERT INTO media (id, topic, title, authorship, owner_principal, file_name,
       upload_bytes, status, created_at, updated_at)
     VALUES (?, ?, ?, 'outros-autores', 'owner', 'a.mp3', 10, 'ready', ?, ?)`,
  );
  db.exec('BEGIN');
  for (let n = 0; n < rows; n += 1)
    insert.run(
      `m${n}`,
      n % 2 === 0 ? 'hermetismo' : 'udv',
      `Áudio ${n}`,
      AT,
      AT,
    );
  db.exec('COMMIT');
  return db;
}

const levelsOf = (db: DatabaseSync) =>
  db
    .prepare('SELECT id, topic, level FROM media ORDER BY id')
    .all()
    .map((row) => ({ ...row }));

describe('the media-level migration (KBC-105 FR-1, AC-10, NFR-2)', () => {
  it('NFR-2: adds the column over 10,000 rows in at most 2 s, keeping every row with no level', () => {
    const db = databaseOfToday(10_000);

    const startedAt = performance.now();
    expect(applyMigrations(db, MEDIA_MIGRATIONS)).toContain(VERSION);
    const ms = performance.now() - startedAt;

    expect(ms).toBeLessThanOrEqual(2_000);
    const counted = db
      .prepare('SELECT count(*) AS n, count(level) AS placed FROM media')
      .get();
    expect({ ...counted }).toEqual({ n: 10_000, placed: 0 });
  });

  it('AC-10: the first start places the existing audios of a scaled collection at its lowest level, once', () => {
    const db = databaseOfToday(4);
    applyMigrations(db, MEDIA_MIGRATIONS);
    const store = new SqliteMediaStore(db);
    const seed = {
      root: 'hermetismo',
      topics: ['hermetismo'],
      level: 'qs',
      now: new Date(AT),
    };

    expect(store.seedLevel({ ...seed, again: false })).toBe(2);
    expect(levelsOf(db)).toEqual([
      { id: 'm0', topic: 'hermetismo', level: 'qs' },
      { id: 'm1', topic: 'udv', level: null },
      { id: 'm2', topic: 'hermetismo', level: 'qs' },
      { id: 'm3', topic: 'udv', level: null },
    ]);

    // A row the previous image writes after the migration (rollback) stays with no level.
    db.prepare(
      `INSERT INTO media (id, topic, title, authorship, owner_principal, file_name,
         upload_bytes, status, created_at, updated_at)
       VALUES ('late', 'hermetismo', 'Do rollback', 'outros-autores', 'owner', 'b.mp3',
         10, 'ready', ?, ?)`,
    ).run(AT, AT);
    expect(store.seedLevel({ ...seed, again: false })).toBeNull();
    expect(store.getMedia('late')?.level).toBeNull();
    // A new scale (created in the app) places it again.
    expect(store.seedLevel({ ...seed, level: 'ci', again: true })).toBe(1);
    expect(store.getMedia('late')?.level).toBe('ci');
    expect(store.getMedia('m0')?.level).toBe('qs');
  });

  it('rollback: the previous image starts over a v31 database and writes it as it did', () => {
    const db = databaseOfToday(1);
    applyMigrations(db, MEDIA_MIGRATIONS);

    // The previous image knows the migrations up to the one before: none to apply, no throw.
    expect(applyMigrations(db, BEFORE)).toEqual([]);
    // Its own insert names its columns: level is left out and stays null (BR-8).
    db.prepare(
      `INSERT INTO media (id, topic, title, authorship, owner_principal, file_name,
         upload_bytes, status, created_at, updated_at)
       VALUES ('old', 'hermetismo', 'Da imagem anterior', 'outros-autores', 'owner',
         'b.mp3', 10, 'ready', ?, ?)`,
    ).run(AT, AT);
    db.prepare(
      `UPDATE media SET title = 'Novo título', updated_at = ? WHERE id = 'm0'`,
    ).run(AT);
    const rows = db
      .prepare(`SELECT id, title, level FROM media ORDER BY id`)
      .all()
      .map((row) => ({ ...row }));
    expect(rows).toEqual([
      { id: 'm0', title: 'Novo título', level: null },
      { id: 'old', title: 'Da imagem anterior', level: null },
    ]);
  });

  it('is applied once: a second start changes nothing', () => {
    const db = databaseOfToday(1);
    applyMigrations(db, MEDIA_MIGRATIONS);

    expect(applyMigrations(db, MEDIA_MIGRATIONS)).toEqual([]);
  });
});
