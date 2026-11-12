import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { applyMigrations } from './media-database.js';
import { MEDIA_MIGRATIONS } from './media-migrations.js';

/** This item's migration, found by name: its number may change on a rebase. */
const MIGRATION = MEDIA_MIGRATIONS.find((one) => one.name === 'track-levels');
if (!MIGRATION) throw new Error('no track-levels migration');
const VERSION = MIGRATION.version;
const BEFORE = MEDIA_MIGRATIONS.filter((one) => one.version < VERSION);
const AT = '2026-11-11T12:00:00.000Z';

describe('the track-levels migration (KBC-106)', () => {
  it('adds what a track of its own needs, with every row following its recording', () => {
    const db = new DatabaseSync(':memory:');
    db.exec('PRAGMA foreign_keys = ON');
    applyMigrations(db, BEFORE);
    db.prepare(
      `INSERT INTO media (id, topic, title, authorship, owner_principal, file_name,
         upload_bytes, status, created_at, updated_at, level)
       VALUES ('r1', 'hermetismo', 'Gravação', 'outros-autores', 'owner', 'a.mp3', 10,
         'ready', ?, ?, 'ci')`,
    ).run(AT, AT);
    db.prepare(
      `INSERT INTO media_draft_tracks (id, media_id, source, start_ms, end_ms, kind, created_at)
       VALUES ('d1', 'r1', 'manual', 0, 30000, 'qa', ?)`,
    ).run(AT);

    expect(applyMigrations(db, MEDIA_MIGRATIONS)).toContain(VERSION);

    expect({
      ...db.prepare(`SELECT level, level_own FROM media WHERE id = 'r1'`).get(),
    }).toEqual({ level: 'ci', level_own: 0 });
    expect(
      db
        .prepare(`SELECT level FROM media_draft_tracks WHERE id = 'd1'`)
        .get()?.['level'],
    ).toBeNull();
    expect(() =>
      db.exec(`UPDATE media SET level_own = 2 WHERE id = 'r1'`),
    ).toThrow();
  });
});
