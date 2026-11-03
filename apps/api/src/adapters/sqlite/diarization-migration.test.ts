import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { applyMigrations } from './media-database.js';
import { MEDIA_MIGRATIONS } from './media-migrations.js';

const BEFORE = MEDIA_MIGRATIONS.filter((one) => one.version < 8);
const MEDIA_ID = '33333333-3333-4333-8333-333333333333';

function seed(db: DatabaseSync): void {
  db.prepare(
    `INSERT INTO media (id, topic, title, authorship, owner_principal, file_name,
       upload_bytes, status, created_at, updated_at)
     VALUES (?, 'hermetismo', 'Palestra', 'outros-autores', 'owner', 'a.mp3', 3, 'ready',
       '2026-11-01T10:00:00.000Z', '2026-11-01T10:00:00.000Z')`,
  ).run(MEDIA_ID);
  db.prepare(
    `INSERT INTO jobs (id, media_id, kind, status, attempts, lease_id, worker, created_at,
       updated_at)
     VALUES ('job-1', ?, 'transcribe', 'leased', 2, 'lease-1', 'transcriber:mac',
       '2026-11-01T10:00:00.000Z', '2026-11-01T10:01:00.000Z')`,
  ).run(MEDIA_ID);
}

describe('migration 8: diarization (KBC-064)', () => {
  it('keeps every job as it was and takes the kind "diarize" with its hint', () => {
    const db = new DatabaseSync(':memory:');
    db.exec('PRAGMA foreign_keys = ON');
    applyMigrations(db, BEFORE);
    seed(db);
    expect(applyMigrations(db, MEDIA_MIGRATIONS)).toEqual([8]);
    expect(
      db
        .prepare(
          'SELECT kind, status, attempts, lease_id, worker, voices FROM jobs',
        )
        .all(),
    ).toEqual([
      {
        kind: 'transcribe',
        status: 'leased',
        attempts: 2,
        lease_id: 'lease-1',
        worker: 'transcriber:mac',
        voices: null,
      },
    ]);
    db.prepare(
      `INSERT INTO jobs (id, media_id, kind, status, voices, created_at, updated_at)
       VALUES ('job-2', ?, 'diarize', 'queued', 2, 'now', 'now')`,
    ).run(MEDIA_ID);
    expect(() =>
      db
        .prepare(
          `INSERT INTO jobs (id, media_id, kind, status, voices, created_at, updated_at)
           VALUES ('job-3', ?, 'diarize', 'queued', 11, 'now', 'now')`,
        )
        .run(MEDIA_ID),
    ).toThrow(/CHECK/);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });

  it('removes the separations of an item with it', () => {
    const db = new DatabaseSync(':memory:');
    db.exec('PRAGMA foreign_keys = ON');
    applyMigrations(db, MEDIA_MIGRATIONS);
    seed(db);
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
  });
});
