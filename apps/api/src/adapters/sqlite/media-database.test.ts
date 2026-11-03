import { describe, expect, it } from 'vitest';
import { assertFullTextSearch, openMediaDatabase } from './media-database.js';
import { MEDIA_MIGRATIONS } from './media-migrations.js';

/** A database whose SQLite was built with these options only. */
const builtWith = (options: readonly string[]) => ({
  prepare: () => ({
    all: () => options.map((option) => ({ compile_options: option })),
  }),
});

describe('assertFullTextSearch (ADR 0024, KBC-039)', () => {
  it('stops the start with the reason when SQLite has no FTS5', () => {
    expect(() =>
      assertFullTextSearch(builtWith(['ENABLE_FTS3', 'THREADSAFE=1'])),
    ).toThrow(/needs SQLite with FTS5: Node .* lacks it/);
  });

  it('lets a SQLite with FTS5 through', () => {
    expect(() =>
      assertFullTextSearch(builtWith(['ENABLE_FTS5'])),
    ).not.toThrow();
    const db = openMediaDatabase(':memory:', MEDIA_MIGRATIONS);
    expect(() => assertFullTextSearch(db)).not.toThrow();
    db.close();
  });
});
