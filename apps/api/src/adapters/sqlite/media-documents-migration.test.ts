import type { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { applyMigrations, openMediaDatabase } from './media-database.js';
import { MEDIA_MIGRATIONS } from './media-migrations.js';

const AT = '2026-11-06T00:00:00.000Z';
const upTo = (version: number) =>
  MEDIA_MIGRATIONS.filter((one) => one.version <= version);
const only = (version: number) =>
  MEDIA_MIGRATIONS.filter((one) => one.version === version);

/** A library at version 24 with a month of spend. */
function before25(): DatabaseSync {
  const db = openMediaDatabase(':memory:', upTo(24));
  db.exec(`INSERT INTO media_spend (id, kind, media_id, principal, reserved_usd, spent_usd,
      status, created_at, settled_at)
    VALUES ('s1', 'track-proposal', NULL, 'owner', 0.5, 0.4, 'settled', '${AT}', '${AT}')`);
  return db;
}

/**
 * Both rebuild `media_spend` adding their kind to its CHECK list, so the list's order follows
 * the order they ran in: the same set of kinds is the same schema.
 */
const sortedKinds = (sql: unknown) =>
  String(sql).replace(
    /kind IN \(([^)]*)\)/g,
    (_all, list: string) => `kind IN (${list.split(', ').sort().join(', ')})`,
  );

const schemaOf = (db: DatabaseSync) =>
  db
    .prepare(
      `SELECT type, name, sql FROM sqlite_master
       WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name`,
    )
    .all()
    .map((row) => ({ ...row, sql: sortedKinds(row['sql']) }));

const spend = (db: DatabaseSync, id: string, kind: string) =>
  db
    .prepare(
      `INSERT INTO media_spend (id, kind, media_id, principal, reserved_usd, spent_usd,
         status, created_at, settled_at) VALUES (?, ?, NULL, 'x', 0.1, 0.1, 'settled', ?, ?)`,
    )
    .run(id, kind, AT, AT);

describe('Migration 26: track documents (KBC-099, PD-21)', () => {
  it('ends in the same schema whether 25 (KBC-037) comes before or after it, both spend kinds kept', () => {
    const inOrder = before25();
    expect(applyMigrations(inOrder, upTo(26))).toEqual([25, 26]);
    const swapped = before25();
    expect(applyMigrations(swapped, [...upTo(24), ...only(26)])).toEqual([26]);
    expect(applyMigrations(swapped, upTo(26))).toEqual([25]);

    expect(schemaOf(swapped)).toEqual(schemaOf(inOrder));
    for (const db of [inOrder, swapped]) {
      spend(db, 'g', 'groq-transcription');
      spend(db, 'k', 'kb-publish');
      expect(() => spend(db, 'x', 'nothing')).toThrow();
      expect(
        db.prepare('SELECT id FROM media_spend ORDER BY id').all(),
      ).toEqual([{ id: 'g' }, { id: 'k' }, { id: 's1' }]);
      db.close();
    }
  });
});
