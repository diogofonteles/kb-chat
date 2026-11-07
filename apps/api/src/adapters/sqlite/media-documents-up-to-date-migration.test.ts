import { describe, expect, it } from 'vitest';
import { applyMigrations, openMediaDatabase } from './media-database.js';
import { MEDIA_MIGRATIONS } from './media-migrations.js';

const AT = '2026-11-07T00:00:00.000Z';
const SHA = 'a'.repeat(64);
const upTo = (version: number) =>
  MEDIA_MIGRATIONS.filter((one) => one.version <= version);

describe('Migration 28: track documents always up to date (KBC-100, PD-21)', () => {
  it('keeps the documents of 26, the runs of 27 and adds what production sees, removals and syncs', () => {
    const db = openMediaDatabase(':memory:', upTo(27));
    db.prepare(
      `INSERT INTO media_documents (media_id, topic, path, desired_sha256, state, updated_at)
       VALUES ('m1', 'hermetismo', 'raw/media/r/m1.md', ?, 'pending', ?)`,
    ).run(SHA, AT);
    expect(applyMigrations(db, upTo(28))).toEqual([28]);

    expect(
      db
        .prepare('SELECT media_id, live_sha256, live_at FROM media_documents')
        .all(),
    ).toEqual([{ media_id: 'm1', live_sha256: null, live_at: null }]);
    db.prepare(
      `INSERT INTO media_document_removals (topic, path, media_id, created_at, updated_at)
       VALUES ('hermetismo', 'raw/media/r/m1.md', 'm1', ?, ?)`,
    ).run(AT, AT);
    // One removal per place in the vault.
    expect(() =>
      db
        .prepare(
          `INSERT INTO media_document_removals (topic, path, media_id, created_at, updated_at)
           VALUES ('hermetismo', 'raw/media/r/m1.md', 'm2', ?, ?)`,
        )
        .run(AT, AT),
    ).toThrow();
    expect(() =>
      db
        .prepare(
          `INSERT INTO vault_syncs (id, worker, ok, detail, started_at, finished_at)
           VALUES ('s', 'mac', 2, '', ?, ?)`,
        )
        .run(AT, AT),
    ).toThrow();
  });
});
