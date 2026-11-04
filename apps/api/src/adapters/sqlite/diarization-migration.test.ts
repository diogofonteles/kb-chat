import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { applyMigrations } from './media-database.js';
import { MEDIA_MIGRATIONS, type Migration } from './media-migrations.js';

/** A database as the app leaves it at KBC-044's silence maps (10), before 11. */
const THROUGH_TEN = MEDIA_MIGRATIONS.filter((one) => one.version <= 10);
/** Up to 11: later ones (KBC-039's index) are not what this proves. */
const THROUGH_ELEVEN = MEDIA_MIGRATIONS.filter((one) => one.version <= 11);
/** Up to the search index: KBC-065's 13 needs 8, which some of these leave out on purpose. */
const THROUGH_TWELVE = MEDIA_MIGRATIONS.filter((one) => one.version <= 12);
const MEDIA_ID = '33333333-3333-4333-8333-333333333333';
const AT = '2026-11-01T10:00:00.000Z';

function freshDatabase(
  migrations: readonly Migration[] = THROUGH_TEN,
): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  applyMigrations(db, migrations);
  db.prepare(
    `INSERT INTO media (id, topic, title, authorship, owner_principal, file_name,
       upload_bytes, status, created_at, updated_at)
     VALUES (?, 'hermetismo', 'Palestra', 'outros-autores', 'owner', 'a.mp3', 3, 'ready',
       ?, ?)`,
  ).run(MEDIA_ID, AT, AT);
  return db;
}

const indexesOf = (db: DatabaseSync) =>
  db
    .prepare(
      `SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'jobs'
         AND name NOT LIKE 'sqlite_%' ORDER BY name`,
    )
    .all()
    .map((row) => row['name']);

describe('migration 11: jobs take the kind "diarize" after the silence maps (KBC-064)', () => {
  it('keeps every job of a database at version 10, a silences one with its detector version', () => {
    const db = freshDatabase();
    db.prepare(
      `INSERT INTO jobs (id, media_id, kind, status, attempts, lease_id, worker,
         created_at, updated_at, detector_version)
       VALUES ('job-1', ?, 'transcribe', 'leased', 2, 'lease-1', 'transcriber:mac', ?, ?,
         NULL),
       ('job-2', ?, 'silences', 'queued', 0, NULL, NULL, ?, ?, 1)`,
    ).run(MEDIA_ID, AT, AT, MEDIA_ID, AT, AT);

    expect(applyMigrations(db, THROUGH_ELEVEN)).toEqual([11]);

    expect(
      db
        .prepare(
          `SELECT id, kind, status, attempts, lease_id, worker, detector_version, voices
           FROM jobs ORDER BY id`,
        )
        .all(),
    ).toEqual([
      {
        id: 'job-1',
        kind: 'transcribe',
        status: 'leased',
        attempts: 2,
        lease_id: 'lease-1',
        worker: 'transcriber:mac',
        detector_version: null,
        voices: null,
      },
      {
        id: 'job-2',
        kind: 'silences',
        status: 'queued',
        attempts: 0,
        lease_id: null,
        worker: null,
        detector_version: 1,
        voices: null,
      },
    ]);
    expect(indexesOf(db)).toEqual([
      'jobs_by_media',
      'jobs_by_worker',
      'jobs_leased',
      'jobs_queued',
    ]);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });

  it('takes "diarize" with its hint beside "silences", and refuses a hint out of 1–10', () => {
    const db = freshDatabase(THROUGH_ELEVEN);
    const insert = db.prepare(
      `INSERT INTO jobs (id, media_id, kind, status, voices, detector_version, created_at,
         updated_at) VALUES (?, ?, ?, 'queued', ?, ?, ?, ?)`,
    );
    insert.run('job-d', MEDIA_ID, 'diarize', 2, null, AT, AT);
    insert.run('job-s', MEDIA_ID, 'silences', null, 1, AT, AT);
    expect(
      db.prepare('SELECT id, kind, voices FROM jobs ORDER BY id').all(),
    ).toEqual([
      { id: 'job-d', kind: 'diarize', voices: 2 },
      { id: 'job-s', kind: 'silences', voices: null },
    ]);
    expect(() =>
      insert.run('job-x', MEDIA_ID, 'diarize', 11, null, AT, AT),
    ).toThrow(/CHECK/);
    expect(() =>
      insert.run('job-y', MEDIA_ID, 'translate', null, null, AT, AT),
    ).toThrow(/CHECK/);
  });

  it('is applied on a database already at 10 even after 8 and 9 were missing', () => {
    const db = new DatabaseSync(':memory:');
    db.exec('PRAGMA foreign_keys = ON');
    applyMigrations(
      db,
      THROUGH_TWELVE.filter((one) => ![8, 9, 11].includes(one.version)),
    );
    expect(applyMigrations(db, THROUGH_ELEVEN)).toEqual([8, 9, 11]);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });

  it('is applied on a database that already has the search index (12)', () => {
    const db = freshDatabase(
      THROUGH_TWELVE.filter((one) => ![8, 11].includes(one.version)),
    );
    expect(applyMigrations(db, THROUGH_TWELVE)).toEqual([8, 11]);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    expect(indexesOf(db)).toHaveLength(4);
    expect(
      db
        .prepare(`SELECT name FROM sqlite_master WHERE name = 'segments_fts'`)
        .all(),
    ).toHaveLength(1);
  });
});

describe('migration 8: the separation tables (KBC-064)', () => {
  it('leaves `jobs` alone and removes the separations of an item with it', () => {
    const db = freshDatabase(MEDIA_MIGRATIONS);
    db.exec(`INSERT INTO transcripts (id, media_id, version, provider, model, parameters,
        parameters_version, terms_version, vad, speech_ratio, elapsed_ms, raw_path,
        filter_version, confidence_version, confidence, word_count, removed_words, low_words,
        created_at)
      VALUES ('t1', '${MEDIA_ID}', 1, 'mlx-whisper', 'm', '{}', 'p', 1, 'applied', 1, 1, 'r',
        1, 1, 'normal', 1, 0, 0, 'now')`);
    db.exec(`INSERT INTO diarizations (id, media_id, version, transcript_id, engine, model,
        parameters, parameters_version, voice_count, elapsed_ms, raw_path, derivation_version,
        created_at)
      VALUES ('d1', '${MEDIA_ID}', 1, 't1', 'senko', 'm', '{}', 'p', 1, 1, 'r', 1, 'now')`);
    db.exec(`INSERT INTO media_speaker_turns VALUES ('d1', 0, 1, 0, 1000)`);
    db.exec(`DELETE FROM media WHERE id = '${MEDIA_ID}'`);
    expect(db.prepare('SELECT count(*) AS n FROM diarizations').get()).toEqual({
      n: 0,
    });
    expect(
      db.prepare('SELECT count(*) AS n FROM media_speaker_turns').get(),
    ).toEqual({ n: 0 });
    const eight = MEDIA_MIGRATIONS.find((one) => one.version === 8);
    expect(eight?.sql).not.toMatch(/\bjobs\b/);
  });
});
