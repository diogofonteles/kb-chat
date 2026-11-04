import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { applyMigrations } from './media-database.js';
import { MEDIA_MIGRATIONS } from './media-migrations.js';

/** This item's migration, found by name: its number may change on a rebase. */
const VERSION = MEDIA_MIGRATIONS.find(
  (one) => one.name === 'word-highlight',
)?.version;
const BEFORE = MEDIA_MIGRATIONS.filter((one) => one.version < (VERSION ?? 0));

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
    expect(plan.join(' ')).toContain('words_by_segment');
    expect(plan.join(' ')).not.toContain('TEMP B-TREE');
    db.close();
  });
});
