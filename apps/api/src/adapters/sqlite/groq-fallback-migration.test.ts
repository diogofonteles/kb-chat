import type { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { applyMigrations, openMediaDatabase } from './media-database.js';
import { MEDIA_MIGRATIONS } from './media-migrations.js';

const AT = '2026-11-05T00:00:00.000Z';
const upTo = (version: number) =>
  MEDIA_MIGRATIONS.filter((one) => one.version <= version);
const only = (version: number) =>
  MEDIA_MIGRATIONS.filter((one) => one.version === version);

/** A library at version 23 with a queued transcription and a month of spend. */
function before24(): DatabaseSync {
  const db = openMediaDatabase(':memory:', upTo(23));
  db.exec(`INSERT INTO media (id, topic, title, authorship, owner_principal, file_name,
      upload_bytes, status, created_at, updated_at)
    VALUES ('m1', 'udv', 'A', 'outros-autores', 'a', 'a.mp3', 3, 'ready', '${AT}', '${AT}')`);
  db.exec(`INSERT INTO jobs (id, media_id, kind, status, attempts, created_at, updated_at)
    VALUES ('j1', 'm1', 'transcribe', 'queued', 2, '${AT}', '${AT}')`);
  db.exec(`INSERT INTO media_spend (id, kind, media_id, principal, reserved_usd, spent_usd,
      status, created_at, settled_at)
    VALUES ('s1', 'track-proposal', 'm1', 'owner', 0.5, 0.4, 'settled', '${AT}', '${AT}')`);
  return db;
}

const schemaOf = (db: DatabaseSync) =>
  db
    .prepare(
      `SELECT type, name, sql FROM sqlite_master
       WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name`,
    )
    .all();

describe('Migration 25: Groq as the transcription fallback (KBC-037)', () => {
  it('ends in the same schema whether 24 (KBC-090) comes before or after it', () => {
    const inOrder = before24();
    expect(applyMigrations(inOrder, MEDIA_MIGRATIONS)).toEqual([24, 25]);
    const swapped = before24();
    expect(applyMigrations(swapped, [...upTo(23), ...only(25)])).toEqual([25]);
    expect(applyMigrations(swapped, MEDIA_MIGRATIONS)).toEqual([24]);

    expect(schemaOf(swapped)).toEqual(schemaOf(inOrder));
    expect(swapped.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    inOrder.close();
    swapped.close();
  });

  it('keeps the rows it finds: the spend, and the job unrouted with its attempts', () => {
    const db = before24();
    applyMigrations(db, MEDIA_MIGRATIONS);

    expect(
      db.prepare('SELECT id, kind, spent_usd, status FROM media_spend').all(),
    ).toEqual([
      { id: 's1', kind: 'track-proposal', spent_usd: 0.4, status: 'settled' },
    ]);
    expect(
      db
        .prepare('SELECT route, hold, attempts, transcriber_attempts FROM jobs')
        .all(),
    ).toEqual([
      { route: null, hold: null, attempts: 2, transcriber_attempts: null },
    ]);
    db.exec(`INSERT INTO media_spend (id, kind, media_id, principal, reserved_usd, status,
        created_at) VALUES ('s2', 'groq-transcription', 'm1', 'groq', 0.01, 'reserved', '${AT}')`);
    expect(db.prepare('SELECT count(*) AS n FROM groq_chunks').get()).toEqual({
      n: 0,
    });
    db.close();
  });
});
