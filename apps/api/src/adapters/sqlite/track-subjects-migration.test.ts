import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { openMediaDatabase } from './media-database.js';
import { MEDIA_MIGRATIONS } from './media-migrations.js';

const upTo = (version: number) =>
  MEDIA_MIGRATIONS.filter((one) => one.version <= version);

const ddlOf = (db: ReturnType<typeof openMediaDatabase>, table: string) =>
  String(
    db.prepare(`SELECT sql FROM sqlite_master WHERE name = ?`).get(table)?.[
      'sql'
    ],
  );

describe('Migration 20: track subjects (KBC-069)', () => {
  it('adds subject-proposal to a media_spend as it stands, indexes and rows kept', () => {
    const db = openMediaDatabase(':memory:', upTo(19));
    const id = randomUUID();
    db.prepare(
      `INSERT INTO media_spend (id, kind, principal, reserved_usd, status, created_at)
       VALUES (?, 'track-proposal', 'owner', 0.1, 'settled', '2026-11-04T00:00:00.000Z')`,
    ).run(id);
    const migration = MEDIA_MIGRATIONS.find((one) => one.version === 20);
    if (!migration || typeof migration.sql === 'string')
      throw new Error('migration 20 reads the database first');
    db.exec(migration.sql(db));

    expect(ddlOf(db, 'media_spend')).toContain(`'subject-proposal'`);
    expect(ddlOf(db, 'media_spend')).toContain(`'track-proposal'`);
    expect(ddlOf(db, 'media_spend_by_time')).toContain('created_at');
    expect(
      db
        .prepare('SELECT count(*) AS n FROM media_spend WHERE id = ?')
        .get(id)?.['n'],
    ).toBe(1);
    db.exec(`INSERT INTO media_spend (id, kind, principal, reserved_usd, status, created_at)
      VALUES ('x', 'subject-proposal', 'owner', 0.1, 'reserved', '2026-11-04T00:00:00.000Z')`);
  });

  it('leaves jobs untouched and refuses an accepted row of a name not yet a subject', () => {
    const before = openMediaDatabase(':memory:', upTo(19));
    const jobs = ddlOf(before, 'jobs');
    before.close();
    // KBC-037's 25 adds columns to `jobs` later on, on purpose: up to 20 here.
    const db = openMediaDatabase(':memory:', upTo(20));
    expect(ddlOf(db, 'jobs')).toBe(jobs);
    db.prepare(
      `INSERT INTO media (id, topic, title, authorship, owner_principal, file_name,
         upload_bytes, status, created_at, updated_at)
       VALUES ('m', 't', 'a', 'outros-autores', 'o', 'f', 1, 'ready', 'x', 'x')`,
    ).run();
    expect(() =>
      db
        .prepare(
          `INSERT INTO media_subject_links (id, media_id, kind, subject_key, new_name, source,
             status, created_at) VALUES ('l', 'm', 'new', 'new:x', 'X', 'ai', 'accepted', 'x')`,
        )
        .run(),
    ).toThrow(/CHECK/);
  });
});
