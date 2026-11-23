import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { applyMigrations } from './media-database.js';
import { MEDIA_MIGRATIONS } from './media-migrations.js';
import { SqliteListeningStore } from './sqlite-listening-store.js';

/** This item's migration, found by name: its number may change on a rebase. */
const VERSION = MEDIA_MIGRATIONS.find(
  (one) => one.name === 'stop-at-passage-end',
)?.version;
const BEFORE = MEDIA_MIGRATIONS.filter((one) => one.version < (VERSION ?? 0));

describe('stop-at-passage-end migration (KBC-160)', () => {
  it('turns the stop on for who already has preferences (BR-4)', () => {
    const db = new DatabaseSync(':memory:');
    applyMigrations(db, BEFORE);
    db.prepare(
      `INSERT INTO media_preferences (principal, speed, show_remaining, word_highlight, updated_at)
       VALUES ('owner', 1.5, 1, 0, '2026-11-17T10:00:00.000Z')`,
    ).run();
    expect(applyMigrations(db, MEDIA_MIGRATIONS)).toEqual([VERSION]);
    expect(new SqliteListeningStore(db).preferencesOf('owner')).toMatchObject({
      speed: 1.5,
      wordHighlight: false,
      stopAtPassageEnd: true,
    });
    db.close();
  });

  it('keeps a choice to turn it off', () => {
    const db = new DatabaseSync(':memory:');
    applyMigrations(db, MEDIA_MIGRATIONS);
    const store = new SqliteListeningStore(db);
    db.prepare(
      `INSERT INTO media_preferences (principal, speed, show_remaining, updated_at)
       VALUES ('owner', 1, 1, '2026-11-17T10:00:00.000Z')`,
    ).run();
    const preferences = store.preferencesOf('owner');
    if (!preferences) throw new Error('no preferences');
    store.savePreferences({
      principal: 'owner',
      preferences: { ...preferences, stopAtPassageEnd: false },
      now: new Date('2026-11-17T11:00:00.000Z'),
    });
    expect(store.preferencesOf('owner')?.stopAtPassageEnd).toBe(false);
    expect(() =>
      db.prepare('UPDATE media_preferences SET stop_at_passage_end = 2').run(),
    ).toThrow(/CHECK/);
    db.close();
  });
});
