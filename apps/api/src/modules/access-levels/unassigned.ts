import { posix } from 'node:path';
import type {
  UnassignedDocument,
  UnassignedFilter,
  UnassignedOrigin,
  UnassignedPage,
} from '@kb-chat/contracts';
import { AppError } from '../../app-error.js';
import type { CatalogEntry } from '../catalog/index.js';

/**
 * The "Sem nível" queue as pure functions (KBC-107 FR-1): rows, filters, facets and the
 * opaque cursor. The service hands in the documents; nothing here reads state.
 */

/** A document without a level, with what the list and the filters need. */
export type UnassignedRow = UnassignedDocument;

/** The folder of a document in its collection: `raw/x.md` → `raw`, `x.md` → ``. */
export const folderOf = (id: string): string => {
  const dir = posix.dirname(id);
  return dir === '.' ? '' : dir;
};

const originOf = (entry: CatalogEntry): UnassignedOrigin =>
  entry.origin ?? 'text';

export const toRow = (
  topic: string,
  entry: CatalogEntry,
  firstSeenAt: string,
): UnassignedRow => ({
  topic,
  id: entry.id,
  title: entry.title,
  origin: originOf(entry),
  authorship: entry.authorship,
  author: entry.author,
  folder: folderOf(entry.id),
  firstSeenAt,
});

/** Whether a row passes every filter given (BR-3: `asOf` keeps only what had arrived). */
export const matches =
  (filter: UnassignedFilter & { readonly asOf?: string }) =>
  (row: UnassignedRow): boolean =>
    (filter.collection === undefined || row.topic === filter.collection) &&
    (filter.origin === undefined || row.origin === filter.origin) &&
    (filter.authorship === undefined || row.authorship === filter.authorship) &&
    (filter.folder === undefined || row.folder === filter.folder) &&
    (filter.since === undefined || row.firstSeenAt >= filter.since) &&
    (filter.asOf === undefined || row.firstSeenAt <= filter.asOf);

/** Newest first, then by collection and id: the same order on every page. */
export const byArrival = (a: UnassignedRow, b: UnassignedRow): number =>
  b.firstSeenAt.localeCompare(a.firstSeenAt) ||
  a.topic.localeCompare(b.topic) ||
  a.id.localeCompare(b.id);

function countBy<T extends string>(
  rows: readonly UnassignedRow[],
  key: (row: UnassignedRow) => T,
): { value: T; count: number }[] {
  const counts = new Map<T, number>();
  for (const row of rows) counts.set(key(row), (counts.get(key(row)) ?? 0) + 1);
  return [...counts.entries()]
    .map(([value, count]) => ({ value, count }))
    .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value));
}

export const facetsOf = (
  rows: readonly UnassignedRow[],
): UnassignedPage['facets'] => ({
  collections: countBy(rows, (row) => row.topic),
  origins: countBy(rows, (row) => row.origin),
  authorships: countBy(rows, (row) => row.authorship),
  folders: countBy(rows, (row) => row.folder),
});

/** The cursor is the next row's position, opaque to the client. */
export const cursorOf = (offset: number): string =>
  Buffer.from(JSON.stringify({ o: offset })).toString('base64url');

export function offsetOf(cursor: string | undefined): number {
  if (cursor === undefined) return 0;
  try {
    const parsed: unknown = JSON.parse(
      Buffer.from(cursor, 'base64url').toString('utf8'),
    );
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      'o' in parsed &&
      Number.isSafeInteger(parsed.o) &&
      Number(parsed.o) >= 0
    )
      return Number(parsed.o);
  } catch {
    // An unreadable cursor is the client's mistake: answered as one below.
  }
  throw new AppError('VALIDATION_FAILED', 'Invalid cursor', {
    details: { field: 'cursor' },
  });
}
