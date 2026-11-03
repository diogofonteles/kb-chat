import { DatabaseSync } from 'node:sqlite';
import { mediaJobIdSchema } from '@kb-chat/contracts';
import { describe, expect, it } from 'vitest';
import { applyMigrations } from './media-database.js';
import { MEDIA_MIGRATIONS } from './media-migrations.js';
import { SqliteTranscriptStore } from './sqlite-transcript-store.js';

const BEFORE = MEDIA_MIGRATIONS.filter((one) => one.version < 5);
/** Up to this migration: later ones (KBC-049's media-author, KBC-051's library) are tested on their own. */
const THROUGH = MEDIA_MIGRATIONS.filter((one) => one.version <= 5);

function insertMedia(db: DatabaseSync, id: string, status: string): void {
  db.prepare(
    `INSERT INTO media (id, topic, title, authorship, owner_principal, file_name,
       upload_bytes, status, created_at, updated_at)
     VALUES (?, 'hermetismo', 'Palestra', 'mestre-laercio', 'owner', 'a.mp3', 3, ?,
       '2026-10-30T10:00:00.000Z', '2026-10-30T10:00:00.000Z')`,
  ).run(id, status);
  db.prepare(
    `INSERT INTO jobs (id, media_id, kind, status, attempts, created_at, updated_at)
     VALUES (?, ?, 'transcode', ?, 1, '2026-10-30T10:00:00.000Z',
       '2026-10-30T10:00:00.000Z')`,
  ).run(crypto.randomUUID(), id, status === 'ready' ? 'done' : 'queued');
}

describe('migration 5: transcription (KBC-036)', () => {
  it('applies on an empty database with the term list v1', () => {
    const db = new DatabaseSync(':memory:');
    db.exec('PRAGMA foreign_keys = ON');
    expect(applyMigrations(db, THROUGH)).toEqual([1, 2, 3, 4, 5]);
    const terms = new SqliteTranscriptStore(db).currentTerms();
    expect(terms.version).toBe(1);
    expect(terms.terms).toHaveLength(32);
    expect(terms.terms.slice(0, 2)).toEqual(['Mestre Gabriel', 'UDV']);
    expect(terms.terms.at(-1)).toBe('diretoria');
  });

  it('keeps the jobs of a seeded database and queues a transcription of each ready item', () => {
    const db = new DatabaseSync(':memory:');
    db.exec('PRAGMA foreign_keys = ON');
    applyMigrations(db, BEFORE);
    insertMedia(db, '33333333-3333-4333-8333-333333333333', 'ready');
    insertMedia(db, '44444444-4444-4444-8444-444444444444', 'queued');
    expect(applyMigrations(db, THROUGH)).toEqual([5]);
    const jobs = db
      .prepare(
        'SELECT id, media_id, kind, status FROM jobs ORDER BY kind, media_id',
      )
      .all();
    expect(jobs.map((job) => [job['kind'], job['status']])).toEqual([
      ['transcode', 'done'],
      ['transcode', 'queued'],
      ['transcribe', 'queued'],
    ]);
    const transcribe = jobs.find((job) => job['kind'] === 'transcribe');
    expect(transcribe?.['media_id']).toBe(
      '33333333-3333-4333-8333-333333333333',
    );
    // The ids made in SQL are valid v4 uuids (the worker contract checks them).
    expect(mediaJobIdSchema.safeParse(transcribe?.['id']).success).toBe(true);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });

  it('refuses a job kind that does not exist', () => {
    const db = new DatabaseSync(':memory:');
    applyMigrations(db, MEDIA_MIGRATIONS);
    insertMedia(db, '55555555-5555-4555-8555-555555555555', 'ready');
    expect(() =>
      db
        .prepare(
          `INSERT INTO jobs (id, media_id, kind, status, created_at, updated_at)
           VALUES ('x', '55555555-5555-4555-8555-555555555555', 'translate', 'queued',
             'now', 'now')`,
        )
        .run(),
    ).toThrow(/CHECK/);
  });
});
