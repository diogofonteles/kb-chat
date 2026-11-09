import { describe, expect, it } from 'vitest';
import { applyMigrations, openMediaDatabase } from './media-database.js';
import { MEDIA_MIGRATIONS } from './media-migrations.js';

const AT = '2026-11-09T00:00:00.000Z';
const upTo = (version: number) =>
  MEDIA_MIGRATIONS.filter((one) => one.version <= version);

const correction = (overrides: Record<string, unknown> = {}) => ({
  id: 'c1',
  media_id: 'rec',
  transcript_id: 't1',
  version: 1,
  revision: 1,
  kind: 'correct',
  first_position: 3,
  word_count: 1,
  segment_position: 0,
  start_ms: 1_000,
  end_ms: 1_400,
  before: '["Tiuako"]',
  after: 'Tiuaco',
  state: 'active',
  author_principal: 'owner',
  created_at: AT,
  ...overrides,
});

describe('Migration 29: transcript word corrections (KBC-093, ADR 0034, PD-20)', () => {
  it('keeps the transcripts of 28 at revision 0 and adds the log, gone with its media', () => {
    const db = openMediaDatabase(':memory:', upTo(28));
    db.prepare(
      `INSERT INTO media (id, topic, title, authorship, owner_principal, file_name, upload_bytes,
         status, created_at, updated_at)
       VALUES ('rec', 'udv', 'Palestra', 'outros-autores', 'owner', 'a.m4a', 1, 'ready', ?, ?)`,
    ).run(AT, AT);
    db.prepare(
      `INSERT INTO transcripts (id, media_id, version, provider, model, parameters,
         parameters_version, terms_version, vad, speech_ratio, elapsed_ms, raw_path,
         filter_version, confidence_version, confidence, word_count, removed_words,
         low_words, created_at)
       VALUES ('t1', 'rec', 1, 'mlx-whisper', 'm', '{}', '1', 1, 'applied', 1, 0, 'r.json',
         1, 1, 'normal', 0, 0, 0, ?)`,
    ).run(AT);

    expect(applyMigrations(db, upTo(29))).toEqual([29]);

    expect(db.prepare('SELECT id, revision FROM transcripts').all()).toEqual([
      { id: 't1', revision: 0 },
    ]);
    const insert = (row: Record<string, unknown>) => {
      const columns = Object.keys(row);
      db.prepare(
        `INSERT INTO transcript_corrections (${columns.join(', ')})
         VALUES (${columns.map(() => '?').join(', ')})`,
      ).run(...(Object.values(row) as (string | number)[]));
    };
    insert(correction());
    expect(() => insert(correction({ id: 'c2', word_count: 6 }))).toThrow();
    expect(() => insert(correction({ id: 'c3', state: 'gone' }))).toThrow();
    expect(() =>
      insert(correction({ id: 'c4', before: 'not json' })),
    ).toThrow();
    expect(() => insert(correction({ id: 'c5', kind: 'edit' }))).toThrow();

    db.prepare("DELETE FROM media WHERE id = 'rec'").run();
    expect(
      db.prepare('SELECT count(*) AS n FROM transcript_corrections').get(),
    ).toEqual({ n: 0 });
  });
});
