import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { applyMigrations } from './media-database.js';
import { MEDIA_MIGRATIONS } from './media-migrations.js';

const MEDIA_ID = '66666666-6666-4666-8666-666666666666';
/** This item's migration, found by name: its number may change on a rebase. */
const SILENCE_VERSION = MEDIA_MIGRATIONS.find(
  (one) => one.name === 'silence-maps',
)?.version;
const BEFORE = MEDIA_MIGRATIONS.filter(
  (one) => one.version < (SILENCE_VERSION ?? 0),
);

function seed(db: DatabaseSync): void {
  db.prepare(
    `INSERT INTO media (id, topic, title, authorship, owner_principal, file_name,
       upload_bytes, status, created_at, updated_at)
     VALUES (?, 'hermetismo', 'Palestra', 'outros-autores', 'owner', 'a.mp3', 3, 'ready',
       '2026-10-30T10:00:00.000Z', '2026-10-30T10:00:00.000Z')`,
  ).run(MEDIA_ID);
  db.prepare(
    `INSERT INTO jobs (id, media_id, kind, status, attempts, created_at, updated_at)
     VALUES ('job-1', ?, 'transcribe', 'queued', 0, '2026-10-30T10:00:00.000Z',
       '2026-10-30T10:00:00.000Z')`,
  ).run(MEDIA_ID);
  db.prepare(
    `INSERT INTO media_preferences (principal, speed, show_remaining, updated_at)
     VALUES ('owner', 1.5, 1, '2026-10-30T10:00:00.000Z')`,
  ).run();
}

describe('migration silence-maps (KBC-044)', () => {
  it('keeps the jobs and preferences of a seeded database and accepts silences jobs', () => {
    const db = new DatabaseSync(':memory:');
    db.exec('PRAGMA foreign_keys = ON');
    applyMigrations(db, BEFORE);
    seed(db);
    expect(applyMigrations(db, MEDIA_MIGRATIONS)).toEqual(
      MEDIA_MIGRATIONS.filter(
        (one) => one.version >= (SILENCE_VERSION ?? 0),
      ).map((one) => one.version),
    );
    expect(db.prepare('SELECT id, kind, status FROM jobs').all()).toEqual([
      { id: 'job-1', kind: 'transcribe', status: 'queued' },
    ]);
    db.prepare(
      `INSERT INTO jobs (id, media_id, kind, status, created_at, updated_at)
       VALUES ('job-2', ?, 'silences', 'queued', 'now', 'now')`,
    ).run(MEDIA_ID);
    const preferences = db
      .prepare('SELECT speed, skip_silences FROM media_preferences')
      .get();
    expect(preferences).toEqual({ speed: 1.5, skip_silences: 0 });
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });

  it('removes a media item’s map and pauses with the item', () => {
    const db = new DatabaseSync(':memory:');
    db.exec('PRAGMA foreign_keys = ON');
    applyMigrations(db, MEDIA_MIGRATIONS);
    seed(db);
    db.prepare(
      `INSERT INTO media_silence_maps (media_id, rendition, detector_version, noise_db,
         min_silence_ms, interval_count, elapsed_ms, created_at)
       VALUES (?, 'audio', 1, -35, 1000, 1, 10, 'now')`,
    ).run(MEDIA_ID);
    db.prepare(
      'INSERT INTO media_silences (media_id, start_ms, end_ms) VALUES (?, 1000, 2500)',
    ).run(MEDIA_ID);
    db.prepare('DELETE FROM media WHERE id = ?').run(MEDIA_ID);
    expect(
      db.prepare('SELECT count(*) AS n FROM media_silences').get(),
    ).toEqual({ n: 0 });
  });

  it('refuses a pause that ends before it starts', () => {
    const db = new DatabaseSync(':memory:');
    db.exec('PRAGMA foreign_keys = ON');
    applyMigrations(db, MEDIA_MIGRATIONS);
    seed(db);
    db.prepare(
      `INSERT INTO media_silence_maps (media_id, rendition, detector_version, noise_db,
         min_silence_ms, interval_count, elapsed_ms, created_at)
       VALUES (?, 'audio', 1, -35, 1000, 0, 10, 'now')`,
    ).run(MEDIA_ID);
    expect(() =>
      db
        .prepare(
          'INSERT INTO media_silences (media_id, start_ms, end_ms) VALUES (?, 2000, 2000)',
        )
        .run(MEDIA_ID),
    ).toThrow(/CHECK/);
  });
});
