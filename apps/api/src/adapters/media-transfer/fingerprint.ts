import { createHash, type Hash } from 'node:crypto';
import type { DatabaseSync, SQLOutputValue } from 'node:sqlite';
import { columnsOf } from './copy-rows.js';
import { UNIT_TABLES, unitFilter, type UnitTable } from './unit-tables.js';

/**
 * Columns a unit's fingerprint leaves out: the level belongs to production after the first
 * import, and a level change there touches `updated_at` alone (found in the local
 * validation): neither makes the unit look edited in production. A track's own level and the
 * level its draft holds (KBC-106) are levels too.
 */
const OWNED_BY_PRODUCTION: Readonly<Record<string, readonly string[]>> = {
  media: ['level', 'level_own', 'updated_at'],
  media_draft_tracks: ['level'],
};

/**
 * The tables and columns a fingerprint covers, table → sorted columns. The ledger keeps the
 * set its digests used (review M2), so a later migration that adds a column or a table
 * compares the next run on the same set instead of making every unit look changed.
 */
export type DigestColumns = Readonly<Record<string, readonly string[]>>;

/** The set this code fingerprints today, from the schema of `schema`. */
export function digestColumns(db: DatabaseSync, schema: string): DigestColumns {
  const columns: Record<string, string[]> = {};
  for (const table of UNIT_TABLES.filter((one) => one.fingerprint)) {
    const skip = OWNED_BY_PRODUCTION[table.name] ?? [];
    columns[table.name] = columnsOf(db, schema, table.name)
      .filter((column) => !skip.includes(column))
      .sort();
  }
  return columns;
}

/** One text for a set, whatever the order its keys were written in. */
export function digestColumnsText(columns: DigestColumns): string {
  return JSON.stringify(
    Object.keys(columns)
      .sort()
      .map((table) => [table, columns[table]]),
  );
}

export function parseDigestColumns(text: string): DigestColumns {
  const entries = JSON.parse(text) as [string, string[]][];
  return Object.fromEntries(entries);
}

/** `table.column` of the set that `schema` no longer has: those digests cannot be redone. */
export function missingDigestColumns(
  db: DatabaseSync,
  schema: string,
  columns: DigestColumns,
): string[] {
  return Object.entries(columns).flatMap(([table, names]) => {
    const known = UNIT_TABLES.some((one) => one.name === table);
    const there = known ? new Set(columnsOf(db, schema, table)) : new Set();
    return names
      .filter((name) => !there.has(name))
      .map((name) => `${table}.${name}`);
  });
}

const valueOf = (value: SQLOutputValue): unknown =>
  value instanceof Uint8Array ? Buffer.from(value).toString('hex') : value;

function primaryKeyOf(
  db: DatabaseSync,
  schema: string,
  table: string,
): string[] {
  return db
    .prepare(
      `SELECT name FROM pragma_table_info(?, ?) WHERE pk > 0 ORDER BY pk`,
    )
    .all(table, schema)
    .map((row) => String(row['name']));
}

function hashTable(
  hash: Hash,
  db: DatabaseSync,
  at: {
    readonly schema: string;
    readonly table: UnitTable;
    readonly columns: readonly string[];
    readonly ids: string;
  },
): void {
  const { columns } = at;
  const order = primaryKeyOf(db, at.schema, at.table.name).map(
    (c) => `x."${c}"`,
  );
  const rows = db
    .prepare(
      `SELECT ${columns.map((c) => `x."${c}"`).join(', ')} FROM ${at.schema}.${at.table.name} x
       WHERE ${unitFilter(at.table, at.schema)} ORDER BY ${order.join(', ')}`,
    )
    .all({ ids: at.ids });
  hash.update(`${at.table.name}:${JSON.stringify(columns)}\n`);
  for (const row of rows)
    hash.update(
      `${JSON.stringify(columns.map((c) => valueOf(row[c] ?? null)))}\n`,
    );
}

/**
 * The sha256 of a unit's content (ADR 0038 §2): every row of its content tables, columns by
 * name and rows by key, so the same rows give the same value in any database; then the
 * hashes of its files, when given (the package's side). `columns` is the set to cover:
 * today's by default, a ledger line's to compare with it.
 */
export function unitFingerprint(
  db: DatabaseSync,
  unit: {
    readonly schema: string;
    readonly ids: readonly string[];
    readonly fileHashes?: readonly string[];
    readonly columns?: DigestColumns;
  },
): string {
  const columns = unit.columns ?? digestColumns(db, unit.schema);
  const fileHashes = unit.fileHashes ?? [];
  const hash = createHash('sha256');
  const ids = JSON.stringify([...unit.ids].sort());
  for (const table of UNIT_TABLES) {
    const covered = columns[table.name];
    if (covered)
      hashTable(hash, db, {
        schema: unit.schema,
        table,
        columns: covered,
        ids,
      });
  }
  for (const file of fileHashes) hash.update(`file:${file}\n`);
  return hash.digest('hex');
}
