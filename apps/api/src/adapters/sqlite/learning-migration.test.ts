import { describe, expect, it } from 'vitest';
import { applyMigrations, openMediaDatabase } from './media-database.js';
import { MEDIA_MIGRATIONS } from './media-migrations.js';

const AT = '2026-11-09T00:00:00.000Z';
const upTo = (version: number) =>
  MEDIA_MIGRATIONS.filter((one) => one.version <= version);

describe('Migration 30: learning from corrections (KBC-113, ADR 0037 §7, PD-20)', () => {
  it('keeps the term list of 29 as the masters, adds the rule column and the switches', () => {
    const db = openMediaDatabase(':memory:', upTo(29));
    const before = db.prepare('SELECT count(*) AS n FROM terms').get();

    expect(applyMigrations(db, upTo(30))).toEqual([30]);

    expect(
      db
        .prepare("SELECT count(*) AS n FROM terms WHERE source = 'manual'")
        .get(),
    ).toEqual(before);
    expect(() =>
      db
        .prepare(
          "INSERT INTO terms (version, position, term, source) VALUES (1, 999, 'X', 'other')",
        )
        .run(),
    ).toThrow();
    const columns = db
      .prepare('SELECT name FROM pragma_table_info(?)')
      .all('transcript_corrections')
      .map((row) => row['name']);
    expect(columns).toContain('rule_id');
    const insert = db.prepare(
      `INSERT INTO learning_switches (kind, key, enabled, author_principal, author_name, updated_at)
       VALUES (?, ?, ?, 'owner', 'Diogo', ?)`,
    );
    insert.run('rule', 'a'.repeat(32), 0, AT);
    expect(() => insert.run('rule', 'a'.repeat(32), 1, AT)).toThrow();
    expect(() => insert.run('word', 'b'.repeat(32), 1, AT)).toThrow();
    expect(() => insert.run('term', 'b'.repeat(32), 2, AT)).toThrow();
  });
});
