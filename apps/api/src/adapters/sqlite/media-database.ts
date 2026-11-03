import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Migration } from './media-migrations.js';

/**
 * Opens the media database (ADR 0022): WAL so readers never wait for the writer, foreign
 * keys on, a busy timeout for the backup's snapshot, then the pending migrations. Any
 * failure throws, and the API does not start (fail fast).
 */
export function openMediaDatabase(
  path: string,
  migrations: readonly Migration[],
): DatabaseSync {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  try {
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA foreign_keys = ON');
    db.exec('PRAGMA busy_timeout = 5000');
    db.exec('PRAGMA synchronous = NORMAL');
    applyMigrations(db, migrations);
    return db;
  } catch (err) {
    db.close();
    throw err;
  }
}

/** Applies, in order and each in its own transaction, the migrations not applied yet. */
export function applyMigrations(
  db: DatabaseSync,
  migrations: readonly Migration[],
): number[] {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    applied_at TEXT NOT NULL
  ) STRICT`);
  const applied = appliedMigrations(db);
  assertSameNames(applied, migrations);
  const pending = [...migrations]
    .sort((a, b) => a.version - b.version)
    .filter((migration) => !applied.has(migration.version));
  for (const migration of pending) applyMigration(db, migration);
  return pending.map((migration) => migration.version);
}

/** The versions already applied, with the name each one had. */
function appliedMigrations(db: DatabaseSync): Map<number, string> {
  return new Map(
    db
      .prepare('SELECT version, name FROM schema_migrations')
      .all()
      .map((row) => [Number(row['version']), String(row['name'])]),
  );
}

/**
 * A version applied under another name means two branches numbered their migrations alike
 * (KBC-049 and KBC-036): the API refuses to start instead of skipping one in silence.
 */
function assertSameNames(
  applied: ReadonlyMap<number, string>,
  migrations: readonly Migration[],
): void {
  for (const migration of migrations) {
    const name = applied.get(migration.version);
    if (name !== undefined && name !== migration.name)
      throw new Error(
        `Media migration ${migration.version} was applied as "${name}", not "${migration.name}"`,
      );
  }
}

function applyMigration(db: DatabaseSync, migration: Migration): void {
  inTransaction(db, () => {
    db.exec(migration.sql);
    db.prepare(
      'INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)',
    ).run(migration.version, migration.name, new Date().toISOString());
  });
}

/** Runs `work` in an immediate transaction: all of it is written, or none. */
export function inTransaction<T>(db: DatabaseSync, work: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = work();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}
