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
    assertFullTextSearch(db);
    applyMigrations(db, migrations);
    return db;
  } catch (err) {
    db.close();
    throw err;
  }
}

/**
 * The transcripts' search index is FTS5 (ADR 0024): a Node whose SQLite lacks it (before
 * 22.21 was not checked) stops the API with the reason instead of a bare SQL error.
 */
export function assertFullTextSearch(db: {
  prepare(sql: string): { all(): readonly Record<string, unknown>[] };
}): void {
  const options = db
    .prepare('PRAGMA compile_options')
    .all()
    .map((row) => String(row['compile_options']));
  if (!options.includes('ENABLE_FTS5'))
    throw new Error(
      `The media library needs SQLite with FTS5: Node ${process.versions.node} lacks it (use a current Node 22)`,
    );
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
  const keysOn =
    db.prepare('PRAGMA foreign_keys').get()?.['foreign_keys'] === 1;
  const keysOff = migration.rebuildsReferenced === true && keysOn;
  if (keysOff) db.exec('PRAGMA foreign_keys = OFF');
  try {
    inTransaction(db, () => {
      db.exec(
        typeof migration.sql === 'string' ? migration.sql : migration.sql(db),
      );
      if (keysOff) assertForeignKeys(db, migration);
      db.prepare(
        'INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)',
      ).run(migration.version, migration.name, new Date().toISOString());
    });
  } finally {
    if (keysOff) db.exec('PRAGMA foreign_keys = ON');
  }
}

/** A rebuild with the keys off must leave no row pointing nowhere. */
function assertForeignKeys(db: DatabaseSync, migration: Migration): void {
  const broken = db.prepare('PRAGMA foreign_key_check').all();
  if (broken.length > 0)
    throw new Error(
      `Media migration ${migration.version} left ${broken.length} broken foreign keys`,
    );
}

/** The connections inside `inTransaction`: an inner call joins the outer transaction. */
const inProgress = new WeakSet<DatabaseSync>();

/**
 * Runs `work` in an immediate transaction: all of it is written, or none. Called within
 * another, `work` simply belongs to the outer one.
 */
export function inTransaction<T>(db: DatabaseSync, work: () => T): T {
  if (inProgress.has(db)) return work();
  db.exec('BEGIN IMMEDIATE');
  inProgress.add(db);
  try {
    const result = work();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  } finally {
    inProgress.delete(db);
  }
}
