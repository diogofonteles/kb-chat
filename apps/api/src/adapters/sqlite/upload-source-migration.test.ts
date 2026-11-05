import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { applyMigrations } from './media-database.js';
import { MEDIA_MIGRATIONS } from './media-migrations.js';

/** This item's migration, found by name: its number may change on a rebase. */
const VERSION =
  MEDIA_MIGRATIONS.find((one) => one.name === 'upload-source-and-estimate')
    ?.version ?? 0;

describe('Migration upload-source-and-estimate (KBC-035)', () => {
  it('keeps the items and the jobs table, with no hash or estimate for what exists', () => {
    const db = new DatabaseSync(':memory:');
    db.exec('PRAGMA foreign_keys = ON');
    applyMigrations(
      db,
      MEDIA_MIGRATIONS.filter((one) => one.version < VERSION),
    );
    const at = '2026-11-04T10:00:00.000Z';
    db.prepare(
      `INSERT INTO media (id, topic, title, authorship, owner_principal, file_name, upload_bytes,
         status, created_at, updated_at)
       VALUES ('m1', 'hermetismo', 'Palestra', 'outros-autores', 'owner', 'a.mp3', 3, 'ready', ?, ?)`,
    ).run(at, at);
    const jobsBefore = db
      .prepare(`SELECT sql FROM sqlite_master WHERE name = 'jobs'`)
      .get();

    // KBC-037's 25 adds columns to `jobs` later on, on purpose: up to this one here.
    applyMigrations(
      db,
      MEDIA_MIGRATIONS.filter((one) => one.version <= VERSION),
    );

    expect(
      db.prepare(`SELECT source_sha256, estimated_bytes FROM media`).get(),
    ).toEqual({ source_sha256: null, estimated_bytes: null });
    expect(
      db.prepare(`SELECT sql FROM sqlite_master WHERE name = 'jobs'`).get(),
    ).toEqual(jobsBefore);
    expect(() =>
      db.prepare(`UPDATE media SET source_sha256 = 'short'`).run(),
    ).toThrow();
    db.close();
  });
});
