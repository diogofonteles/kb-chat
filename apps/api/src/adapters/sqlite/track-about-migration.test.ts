import type { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { applyMigrations, openMediaDatabase } from './media-database.js';
import { MEDIA_MIGRATIONS } from './media-migrations.js';

const NOW = '2026-11-04T00:00:00.000Z';

function insertMedia(db: DatabaseSync, id: string, parent: string | null) {
  db.prepare(
    `INSERT INTO media (id, topic, title, authorship, owner_principal, file_name, upload_bytes,
       status, created_at, updated_at, parent_media_id, parent_start_ms, parent_end_ms)
     VALUES (?, 'udv', ?, 'outros-autores', 'owner', 'a.m4a', 1, 'ready', ?, ?, ?, ?, ?)`,
  ).run(
    id,
    `Título ${id}`,
    NOW,
    NOW,
    parent,
    parent ? 0 : null,
    parent ? 1000 : null,
  );
}

const found = (db: DatabaseSync, word: string): string[] =>
  db
    .prepare(
      'SELECT media_id FROM track_about_fts WHERE track_about_fts MATCH ?',
    )
    .all(`"${word}"`)
    .map((row) => String(row['media_id']));

const summaryOf = (db: DatabaseSync, id: string, summary: string) =>
  db
    .prepare(
      `INSERT INTO media_track_subjects (media_id, summary, updated_at) VALUES (?, ?, ?)
       ON CONFLICT (media_id) DO UPDATE SET summary = excluded.summary`,
    )
    .run(id, summary, NOW);

describe('Migration 23: the tracks’ title and summary, by word (KBC-070)', () => {
  it('takes the tracks that exist, with their summaries, and no recording', () => {
    const before = MEDIA_MIGRATIONS.filter((one) => one.version < 23);
    const db = openMediaDatabase(':memory:', before);
    insertMedia(db, 'recording', null);
    insertMedia(db, 'track', 'recording');
    summaryOf(db, 'track', 'Sobre a burracheira');

    expect(applyMigrations(db, MEDIA_MIGRATIONS)).toEqual([23]);

    expect(found(db, 'burracheira')).toEqual(['track']);
    expect(found(db, 'track')).toEqual(['track']);
    expect(found(db, 'recording')).toEqual([]);
    db.close();
  });

  it('follows a new track, its title, its summary and its removal, ignoring accents', () => {
    const db = openMediaDatabase(':memory:', MEDIA_MIGRATIONS);
    insertMedia(db, 'recording', null);
    insertMedia(db, 'track', 'recording');
    expect(found(db, 'track')).toEqual(['track']);

    db.prepare(
      `UPDATE media SET title = 'Pergunta nova' WHERE id = 'track'`,
    ).run();
    expect(found(db, 'nova')).toEqual(['track']);
    expect(found(db, 'título')).toEqual([]);

    summaryOf(db, 'track', 'O chá da sessão');
    expect(found(db, 'cha')).toEqual(['track']);
    summaryOf(db, 'track', 'Outro assunto');
    expect(found(db, 'cha')).toEqual([]);
    expect(found(db, 'nova')).toEqual(['track']);

    db.prepare(`DELETE FROM media WHERE id = 'track'`).run();
    expect(found(db, 'nova')).toEqual([]);
    db.close();
  });
});
