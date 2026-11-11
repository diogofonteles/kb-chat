import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { applyMigrations } from './media-database.js';
import { MEDIA_MIGRATIONS } from './media-migrations.js';

const BEFORE = MEDIA_MIGRATIONS.filter(({ version }) => version < 13);
const AT = '2026-11-03T12:00:00.000Z';

describe('media migration 13 (KBC-065)', () => {
  let db: DatabaseSync;
  afterEach(() => db.close());

  function open(): void {
    db = new DatabaseSync(':memory:');
    db.exec('PRAGMA foreign_keys = ON');
  }

  /** One item, its transcript and its separation `d1`. */
  function aSeparation(): void {
    db.exec(`INSERT INTO media (id, topic, title, authorship, owner_principal, file_name,
        upload_bytes, status, created_at, updated_at)
      VALUES ('m1', 'udv', 'A', 'outros-autores', 'a', 'a.mp3', 3, 'ready', '${AT}', '${AT}')`);
    db.exec(`INSERT INTO transcripts (id, media_id, version, provider, model, parameters,
        parameters_version, terms_version, vad, speech_ratio, elapsed_ms, raw_path,
        filter_version, confidence_version, confidence, word_count, removed_words, low_words,
        created_at)
      VALUES ('t1', 'm1', 1, 'mlx-whisper', 'm', '{}', 'p', 1, 'applied', 1, 1, 'r',
        1, 1, 'normal', 1, 0, 0, 'now')`);
    db.exec(`INSERT INTO diarizations (id, media_id, version, transcript_id, engine, model,
        parameters, parameters_version, voice_count, elapsed_ms, raw_path, derivation_version,
        created_at)
      VALUES ('d1', 'm1', 1, 't1', 'senko', 'm', '{}', 'p', 1, 1, 'r', 1, 'now')`);
  }

  it('keeps the separations made before it, with no names waiting', () => {
    open();
    applyMigrations(db, BEFORE);
    aSeparation();
    expect(applyMigrations(db, MEDIA_MIGRATIONS)).toContain(13);
    expect(
      db.prepare('SELECT id, names_pending FROM diarizations').all(),
    ).toEqual([{ id: 'd1', names_pending: 0 }]);
  });

  it('removes the names of a removed separation and keeps the speaker', () => {
    open();
    applyMigrations(db, MEDIA_MIGRATIONS);
    aSeparation();
    db.exec(`INSERT INTO media_speakers (id, collection, name, name_key, created_by,
        created_at, updated_at) VALUES ('s1', 'udv', 'Ana', 'ana', 'a', 'now', 'now')`);
    db.exec(`INSERT INTO media_voice_labels (diarization_id, voice, speaker_id)
      VALUES ('d1', 1, 's1')`);
    db.exec(`DELETE FROM media WHERE id = 'm1'`);
    expect(
      db.prepare('SELECT count(*) AS n FROM media_voice_labels').get(),
    ).toEqual({ n: 0 });
    expect(
      db.prepare('SELECT count(*) AS n FROM media_speakers').get(),
    ).toEqual({ n: 1 });
  });

  it('allows one speaker per name and per author in a collection', () => {
    open();
    applyMigrations(db, MEDIA_MIGRATIONS);
    const add = db.prepare(
      `INSERT INTO media_speakers (id, collection, name, name_key, author_slug, created_by,
         created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'a', '${AT}', '${AT}')`,
    );
    add.run('1', 'udv', 'Ana', 'ana', null);
    add.run('2', 'hermetismo', 'Ana', 'ana', null);
    expect(() => add.run('3', 'udv', 'ANA', 'ana', null)).toThrow();
    add.run('4', 'udv', 'Bia', 'bia', 'mestre');
    expect(() => add.run('5', 'udv', 'Cida', 'cida', 'mestre')).toThrow();
  });
});
