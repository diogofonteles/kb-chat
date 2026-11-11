import { createHash, type Hash } from 'node:crypto';
import type { DatabaseSync, SQLOutputValue } from 'node:sqlite';
import { columnsOf } from './copy-rows.js';
import { UNIT_TABLES, unitFilter } from './unit-tables.js';

/**
 * Columns a unit's fingerprint leaves out: the level belongs to production after the first
 * import, and a level change there touches `updated_at` alone (found in the local
 * validation): neither makes the unit look edited in production.
 */
const OWNED_BY_PRODUCTION: Readonly<Record<string, readonly string[]>> = {
  media: ['level', 'updated_at'],
};

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
    readonly table: (typeof UNIT_TABLES)[number];
    readonly ids: string;
  },
): void {
  const skip = OWNED_BY_PRODUCTION[at.table.name] ?? [];
  const columns = columnsOf(db, at.schema, at.table.name)
    .filter((column) => !skip.includes(column))
    .sort();
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
 * hashes of its files, when given (the package's side).
 */
export function unitFingerprint(
  db: DatabaseSync,
  unit: { readonly schema: string; readonly ids: readonly string[] },
  fileHashes: readonly string[] = [],
): string {
  const hash = createHash('sha256');
  const ids = JSON.stringify([...unit.ids].sort());
  for (const table of UNIT_TABLES.filter((one) => one.fingerprint))
    hashTable(hash, db, { schema: unit.schema, table, ids });
  for (const file of fileHashes) hash.update(`file:${file}\n`);
  return hash.digest('hex');
}
