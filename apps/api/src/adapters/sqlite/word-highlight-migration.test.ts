import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { applyMigrations } from './media-database.js';
import { MEDIA_MIGRATIONS, type Migration } from './media-migrations.js';

/** This item's migration, found by name: its number may change on a rebase. */
const VERSION = MEDIA_MIGRATIONS.find(
  (one) => one.name === 'word-highlight',
)?.version;
const BEFORE = MEDIA_MIGRATIONS.filter((one) => one.version < (VERSION ?? 0));
const OTHERS = MEDIA_MIGRATIONS.filter((one) => one.version !== VERSION);
/** A later item's migration, already on a database that still lacks this one. */
const LATER: Migration = { version: 20, name: 'later-item', sql: 'SELECT 1;' };

describe('word-highlight migration (KBC-045)', () => {
  it('turns the highlight on for who already has preferences', () => {
    const db = new DatabaseSync(':memory:');
    applyMigrations(db, BEFORE);
    db.prepare(
      `INSERT INTO media_preferences (principal, speed, show_remaining, updated_at)
       VALUES ('owner', 1.5, 1, '2026-11-04T10:00:00.000Z')`,
    ).run();
    applyMigrations(db, MEDIA_MIGRATIONS);
    const row = db
      .prepare('SELECT speed, word_highlight FROM media_preferences')
      .get();
    expect(row).toEqual({ speed: 1.5, word_highlight: 1 });
    db.close();
  });

  it("reads a segment's words through the index, not the transcript's", () => {
    const db = new DatabaseSync(':memory:');
    applyMigrations(db, MEDIA_MIGRATIONS);
    const plan = db
      .prepare(
        `EXPLAIN QUERY PLAN SELECT start_ms FROM words
         WHERE transcript_id = 't' AND segment_position >= 100 AND segment_position < 200
         ORDER BY segment_position, position`,
      )
      .all()
      .map((row) => String(row['detail']));
    expect(plan.join(' ')).toContain('USING INDEX words_by_segment_position');
    expect(plan.join(' ')).not.toContain('TEMP B-TREE');
    db.close();
  });

  it('adds no index of its own: track-items already has these columns', () => {
    const db = new DatabaseSync(':memory:');
    applyMigrations(db, MEDIA_MIGRATIONS);
    const indexes = db
      .prepare(
        `SELECT name FROM sqlite_master
         WHERE type = 'index' AND tbl_name = 'words' AND sql IS NOT NULL`,
      )
      .all()
      .map((row) => row['name']);
    expect(indexes).toEqual(['words_by_segment_position']);
    db.close();
  });

  it.each([
    { state: 'at 19', applied: OTHERS, known: MEDIA_MIGRATIONS },
    {
      state: 'at 20',
      applied: [...OTHERS, LATER],
      known: [...MEDIA_MIGRATIONS, LATER],
    },
  ])(
    'reaches a database $state as a missing lower version',
    ({ applied, known }) => {
      const db = new DatabaseSync(':memory:');
      applyMigrations(db, applied);
      db.prepare(
        `INSERT INTO media_preferences (principal, speed, show_remaining, updated_at)
         VALUES ('owner', 1, 1, '2026-11-04T10:00:00.000Z')`,
      ).run();
      expect(applyMigrations(db, known)).toEqual([VERSION]);
      expect(
        db.prepare('SELECT word_highlight FROM media_preferences').get(),
      ).toEqual({ word_highlight: 1 });
      db.close();
    },
  );
});
