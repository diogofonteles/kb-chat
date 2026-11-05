import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { applyMigrations } from './media-database.js';
import { MEDIA_MIGRATIONS } from './media-migrations.js';
import { SqliteListeningStore } from './sqlite-listening-store.js';

const BEFORE = MEDIA_MIGRATIONS.filter((one) => one.version < 7);
/** Up to this migration: later ones are tested on their own. */
const THROUGH = MEDIA_MIGRATIONS.filter((one) => one.version <= 7);
const MEDIA_ID = '33333333-3333-4333-8333-333333333333';
const SAVED_AT = '2026-10-30T10:00:00.000Z';

describe('migration 7: the media library (KBC-051)', () => {
  it('dates the positions already saved as played, and keeps the player’s choices', () => {
    const db = new DatabaseSync(':memory:');
    db.exec('PRAGMA foreign_keys = ON');
    applyMigrations(db, BEFORE);
    db.prepare(
      `INSERT INTO media (id, topic, title, authorship, owner_principal, file_name,
         upload_bytes, status, created_at, updated_at)
       VALUES (?, 'hermetismo', 'Aula', 'outros-autores', 'p', 'a.mp3', 1, 'ready', ?, ?)`,
    ).run(MEDIA_ID, SAVED_AT, SAVED_AT);
    db.prepare(
      `INSERT INTO media_progress (principal, media_id, position_ms, completed_at, updated_at)
       VALUES ('p', ?, 5000, NULL, ?)`,
    ).run(MEDIA_ID, SAVED_AT);
    db.prepare(
      `INSERT INTO media_preferences (principal, speed, show_remaining, updated_at)
       VALUES ('p', 1.5, 0, ?)`,
    ).run(SAVED_AT);

    expect(applyMigrations(db, THROUGH)).toEqual([7]);
    // The store reads columns of later migrations too (KBC-044's skip_silences).
    applyMigrations(db, MEDIA_MIGRATIONS);

    const store = new SqliteListeningStore(db);
    expect(store.allProgressOf('p').get(MEDIA_ID)).toEqual({
      positionMs: 5_000,
      completedAt: null,
      updatedAt: SAVED_AT,
      playedAt: SAVED_AT,
    });
    expect(store.preferencesOf('p')).toEqual({
      speed: 1.5,
      showRemaining: false,
      skipBackSec: 15,
      skipForwardSec: 30,
      skipSilences: false,
      wordHighlight: true,
      librarySort: 'recently-played',
      libraryView: 'list',
      libraryFilters: {
        states: [],
        authors: [],
        topic: null,
        allTopics: false,
        subject: null,
      },
    });
    expect(store.recentsClearedAt('p')).toBeNull();
    db.close();
  });

  it('enters a database already at the newest versions, after them, and keeps its rows', () => {
    const db = new DatabaseSync(':memory:');
    db.exec('PRAGMA foreign_keys = ON');
    applyMigrations(
      db,
      MEDIA_MIGRATIONS.filter((one) => one.version !== 7),
    );
    db.prepare(
      `INSERT INTO media (id, topic, title, authorship, owner_principal, file_name,
         upload_bytes, status, created_at, updated_at)
       VALUES (?, 'hermetismo', 'Aula', 'outros-autores', 'p', 'a.mp3', 1, 'ready', ?, ?)`,
    ).run(MEDIA_ID, SAVED_AT, SAVED_AT);
    db.prepare(
      `INSERT INTO media_progress (principal, media_id, position_ms, completed_at, updated_at)
       VALUES ('p', ?, 5000, NULL, ?)`,
    ).run(MEDIA_ID, SAVED_AT);
    db.prepare(
      `INSERT INTO media_preferences (principal, speed, show_remaining, skip_silences, updated_at)
       VALUES ('p', 1.5, 0, 1, ?)`,
    ).run(SAVED_AT);

    expect(applyMigrations(db, MEDIA_MIGRATIONS)).toEqual([7]);

    const store = new SqliteListeningStore(db);
    expect(store.allProgressOf('p').get(MEDIA_ID)?.playedAt).toBe(SAVED_AT);
    expect(store.preferencesOf('p')).toMatchObject({
      speed: 1.5,
      skipSilences: true,
      wordHighlight: true,
      librarySort: 'recently-played',
      libraryView: 'list',
      libraryFilters: {
        states: [],
        authors: [],
        topic: null,
        allTopics: false,
        subject: null,
      },
    });
    expect(applyMigrations(db, MEDIA_MIGRATIONS)).toEqual([]);
    db.close();
  });

  it('refuses a library order the contract does not know', () => {
    const db = new DatabaseSync(':memory:');
    applyMigrations(db, MEDIA_MIGRATIONS);
    expect(() =>
      db
        .prepare(
          `INSERT INTO media_preferences (principal, speed, show_remaining, updated_at,
             library_sort) VALUES ('p', 1, 1, ?, 'random')`,
        )
        .run(SAVED_AT),
    ).toThrow();
    db.close();
  });
});
