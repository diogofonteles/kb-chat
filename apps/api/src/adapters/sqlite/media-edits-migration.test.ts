import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { applyMigrations } from './media-database.js';
import { MEDIA_MIGRATIONS } from './media-migrations.js';

const MEDIA_ID = '66666666-6666-4666-8666-666666666666';
const AT = '2026-11-03T10:00:00.000Z';
/** This item's migration, found by name: its number may change on a rebase. */
const VERSION = MEDIA_MIGRATIONS.find(
  (one) => one.name === 'media-edits',
)?.version;
const BEFORE = MEDIA_MIGRATIONS.filter((one) => one.version < (VERSION ?? 0));

function seed(db: DatabaseSync): void {
  db.prepare(
    `INSERT INTO media (id, topic, title, authorship, owner_principal, file_name,
       upload_bytes, status, created_at, updated_at)
     VALUES (?, 'hermetismo', 'Palestra', 'outros-autores', 'owner', 'a.mp3', 3, 'ready', ?, ?)`,
  ).run(MEDIA_ID, AT, AT);
  db.prepare(
    `INSERT INTO jobs (id, media_id, kind, status, attempts, created_at, updated_at, voices)
     VALUES ('job-1', ?, 'diarize', 'queued', 0, ?, ?, 3)`,
  ).run(MEDIA_ID, AT, AT);
  db.prepare(
    `INSERT INTO media_draft_tracks (id, media_id, source, first_segment, last_segment,
       start_ms, end_ms, kind, title, created_at)
     VALUES ('t1', ?, 'manual', 1, 2, 0, 9000, 'qa', 'Tema', ?)`,
  ).run(MEDIA_ID, AT);
}

function migrated(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  applyMigrations(db, BEFORE);
  seed(db);
  applyMigrations(db, MEDIA_MIGRATIONS);
  return db;
}

describe('migration media-edits (KBC-066)', () => {
  it('keeps the queue and the draft of a seeded database', () => {
    const db = migrated();
    expect(db.prepare('SELECT kind, voices FROM jobs').get()).toMatchObject({
      kind: 'diarize',
      voices: 3,
    });
    expect(
      db.prepare('SELECT title, first_segment FROM media_draft_tracks').get(),
    ).toMatchObject({ title: 'Tema', first_segment: 1 });
  });

  it('takes waveform jobs, titles of 120 and a person`s track without segments', () => {
    const db = migrated();
    db.prepare(
      `INSERT INTO jobs (id, media_id, kind, status, attempts, created_at, updated_at)
       VALUES ('job-2', ?, 'waveform', 'queued', 0, ?, ?)`,
    ).run(MEDIA_ID, AT, AT);
    db.prepare(
      `INSERT INTO media_draft_tracks (id, media_id, source, start_ms, end_ms, kind, title,
         created_at) VALUES ('t2', ?, 'manual', 9000, 15000, 'talk', ?, ?)`,
    ).run(MEDIA_ID, 'x'.repeat(120), AT);
    expect(
      db.prepare('SELECT count(*) AS n FROM media_draft_tracks').get(),
    ).toMatchObject({ n: 2 });
  });

  it('still refuses a track under 5 s in the database', () => {
    const db = migrated();
    expect(() =>
      db
        .prepare(
          `INSERT INTO media_draft_tracks (id, media_id, source, start_ms, end_ms, kind,
             created_at) VALUES ('t3', ?, 'manual', 0, 4999, 'qa', ?)`,
        )
        .run(MEDIA_ID, AT),
    ).toThrow();
  });
});
