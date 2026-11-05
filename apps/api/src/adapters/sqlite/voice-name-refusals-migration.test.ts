import type { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { applyMigrations, openMediaDatabase } from './media-database.js';
import { MEDIA_MIGRATIONS } from './media-migrations.js';

const AT = '2026-11-05T00:00:00.000Z';

/** A recording at version 23 with a run, a separation and AI and manual draft tracks. */
function before24(): DatabaseSync {
  const db = openMediaDatabase(
    ':memory:',
    MEDIA_MIGRATIONS.filter((one) => one.version < 24),
  );
  db.exec(`INSERT INTO media (id, topic, title, authorship, owner_principal, file_name,
      upload_bytes, status, created_at, updated_at)
    VALUES ('m1', 'udv', 'A', 'outros-autores', 'a', 'a.mp3', 3, 'ready', '${AT}', '${AT}')`);
  db.exec(`INSERT INTO transcripts (id, media_id, version, provider, model, parameters,
      parameters_version, terms_version, vad, speech_ratio, elapsed_ms, raw_path,
      filter_version, confidence_version, confidence, word_count, removed_words, low_words,
      created_at)
    VALUES ('t1', 'm1', 1, 'mlx-whisper', 'm', '{}', 'p', 1, 'applied', 1, 1, 'r',
      1, 1, 'normal', 1, 0, 0, '${AT}')`);
  db.exec(`INSERT INTO diarizations (id, media_id, version, transcript_id, engine, model,
      parameters, parameters_version, voice_count, elapsed_ms, raw_path, derivation_version,
      created_at)
    VALUES ('d1', 'm1', 1, 't1', 'senko', 'm', '{}', 'p', 1, 1, 'r', 1, '${AT}')`);
  db.exec(`INSERT INTO media_proposal_runs (id, media_id, transcript_id, principal, model,
      spend_id, status, windows_total, estimate_usd, created_at)
    VALUES ('r1', 'm1', 't1', 'a', 'm', 's1', 'done', 1, 0, '${AT}')`);
  db.exec(`INSERT INTO media_voice_suggestions (run_id, voice, name, audience, reason)
    VALUES ('r1', 1, 'Márcio da Roça', 0, 'diz o nome')`);
  const track = db.prepare(
    `INSERT INTO media_draft_tracks (id, media_id, run_id, source, edited, start_ms, end_ms,
       kind, title, created_at)
     VALUES (?, 'm1', 'r1', ?, ?, ?, ?, 'qa', ?, '${AT}')`,
  );
  track.run('ai-untouched', 'ai', 0, 0, 9000, 'Conversa com Márcio da Roça');
  track.run('ai-approved', 'ai', 1, 9000, 18000, 'Márcio da Roça responde');
  track.run('manual', 'manual', 1, 18000, 27000, 'Escrito por mim');
  return db;
}

const rows = (db: DatabaseSync, sql: string) => db.prepare(sql).all();

describe('Migration 24: refused names and who wrote a title (KBC-090)', () => {
  it('keeps the tracks, and a title already approved counts as a person’s', () => {
    const db = before24();

    expect(applyMigrations(db, MEDIA_MIGRATIONS)).toEqual([24]);

    expect(
      rows(
        db,
        'SELECT id, title, edited, person_edited FROM media_draft_tracks ORDER BY start_ms',
      ),
    ).toEqual([
      {
        id: 'ai-untouched',
        title: 'Conversa com Márcio da Roça',
        edited: 0,
        person_edited: 0,
      },
      {
        id: 'ai-approved',
        title: 'Márcio da Roça responde',
        edited: 1,
        person_edited: 1,
      },
      { id: 'manual', title: 'Escrito por mim', edited: 1, person_edited: 1 },
    ]);
    expect(
      rows(db, 'SELECT voice, name, written_name FROM media_voice_suggestions'),
    ).toEqual([{ voice: 1, name: 'Márcio da Roça', written_name: null }]);
    expect(rows(db, 'SELECT * FROM media_voice_refusals')).toEqual([]);
    expect(applyMigrations(db, MEDIA_MIGRATIONS)).toEqual([]);
    db.close();
  });

  it('a refusal is one per voice of a separation, and leaves with it', () => {
    const db = before24();
    applyMigrations(db, MEDIA_MIGRATIONS);
    const refuse = db.prepare(
      `INSERT INTO media_voice_refusals (diarization_id, voice, refused_by, refused_at)
       VALUES ('d1', ?, 'a', '${AT}')`,
    );
    refuse.run(1);
    expect(() => refuse.run(1)).toThrow();
    expect(() => refuse.run(11)).toThrow();
    expect(() =>
      db
        .prepare(
          `UPDATE media_draft_tracks SET person_edited = 2 WHERE id = 'manual'`,
        )
        .run(),
    ).toThrow();

    db.exec(`DELETE FROM diarizations WHERE id = 'd1'`);
    expect(rows(db, 'SELECT * FROM media_voice_refusals')).toEqual([]);
    db.close();
  });
});
