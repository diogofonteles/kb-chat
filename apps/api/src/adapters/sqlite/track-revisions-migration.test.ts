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

describe('Migration 22: track revisions (KBC-073)', () => {
  it('leaves `jobs` as it stands and takes a new kind of spend', () => {
    const db = openMediaDatabase(':memory:', upTo(20));
    const jobs = ddlOf(db, 'jobs');
    db.exec(`INSERT INTO media_spend (id, kind, principal, reserved_usd, status, created_at)
      VALUES ('a', 'subject-proposal', 'owner', 0.1, 'settled', '2026-11-04T00:00:00.000Z')`);
    const migration = MEDIA_MIGRATIONS.find((one) => one.version === 22);
    if (!migration || typeof migration.sql === 'string')
      throw new Error('migration 22 reads the database first');

    db.exec(migration.sql(db));

    expect(ddlOf(db, 'jobs')).toBe(jobs);
    expect(ddlOf(db, 'media_spend')).toContain(`'track-suggestion'`);
    expect(ddlOf(db, 'media_spend_by_time')).toContain('created_at');
    expect(
      db.prepare(`SELECT kind FROM media_spend WHERE id = 'a'`).get()?.['kind'],
    ).toBe('subject-proposal');
    db.exec(`INSERT INTO media_spend (id, kind, principal, reserved_usd, status, created_at)
      VALUES ('b', 'track-suggestion', 'owner', 0.1, 'reserved', '2026-11-04T00:00:00.000Z')`);
  });

  it('runs whole with every migration', () => {
    const db = openMediaDatabase(':memory:', MEDIA_MIGRATIONS);

    const columns = db
      .prepare(`SELECT name FROM pragma_table_info('media')`)
      .all()
      .map((row) => String(row['name']));

    expect(columns).toContain('track_version');
    expect(columns).toContain('file_version');
  });
});
