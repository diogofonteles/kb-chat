import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { applyMigrations } from './media-database.js';
import {
  MEDIA_MIGRATIONS,
  rebuildRunsAcceptingLimit,
  type Migration,
} from './media-migrations.js';

const MEDIA_ID = '77777777-7777-4777-8777-777777777777';
const AT = '2026-11-07T10:00:00.000Z';
/** This item's migration, found by name: its number may change on a rebase. */
const VERSION = MEDIA_MIGRATIONS.find(
  (one) => one.name === 'proposal-accepted-limit',
)?.version;
const BEFORE = MEDIA_MIGRATIONS.filter((one) => one.version < (VERSION ?? 0));

function seed(db: DatabaseSync): void {
  db.prepare(
    `INSERT INTO media (id, topic, title, authorship, owner_principal, file_name,
       upload_bytes, status, created_at, updated_at)
     VALUES (?, 'hermetismo', 'Palestra', 'outros-autores', 'owner', 'a.mp3', 3, 'ready', ?, ?)`,
  ).run(MEDIA_ID, AT, AT);
  db.prepare(
    `INSERT INTO transcripts (id, media_id, version, provider, model, parameters,
       parameters_version, terms_version, vad, speech_ratio, elapsed_ms, raw_path,
       filter_version, confidence_version, confidence, word_count, removed_words,
       low_words, created_at)
     VALUES ('tr1', ?, 1, 'p', 'm', '{}', '1', 1, 'applied', 0.9, 1, 'r', 1, 1, 'normal',
       1, 0, 0, ?)`,
  ).run(MEDIA_ID, AT);
  db.prepare(
    `INSERT INTO media_proposal_runs (id, media_id, transcript_id, principal, model,
       spend_id, status, windows_total, windows_done, estimate_usd, spent_usd, failure,
       created_at, carried_usd)
     VALUES ('run-1', ?, 'tr1', 'owner', 'stub', 'spend-1', 'failed', 3, 1, 0.01, 0.004,
       'provider', ?, 0.001)`,
  ).run(MEDIA_ID, AT);
  db.prepare(
    `INSERT INTO media_draft_tracks (id, media_id, run_id, source, first_segment,
       last_segment, start_ms, end_ms, kind, title, created_at)
     VALUES ('t1', ?, 'run-1', 'ai', 1, 2, 0, 9000, 'qa', 'Tema', ?)`,
  ).run(MEDIA_ID, AT);
  db.prepare(
    `INSERT INTO media_voice_suggestions (run_id, voice, name, audience, reason)
     VALUES ('run-1', 1, 'Mestre', 0, 'responde')`,
  ).run();
}

function migrated(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  applyMigrations(db, BEFORE);
  seed(db);
  applyMigrations(db, MEDIA_MIGRATIONS);
  return db;
}

describe('migration proposal-accepted-limit (KBC-112)', () => {
  it('keeps every run and what hangs from it: no cascade on the rebuild', () => {
    const db = migrated();
    expect(
      db
        .prepare(
          'SELECT id, status, failure, spent_usd, carried_usd, limit_usd FROM media_proposal_runs',
        )
        .get(),
    ).toEqual({
      id: 'run-1',
      status: 'failed',
      failure: 'provider',
      spent_usd: 0.004,
      carried_usd: 0.001,
      limit_usd: null,
    });
    expect(
      db.prepare('SELECT count(*) AS n FROM media_draft_tracks').get(),
    ).toEqual({ n: 1 });
    expect(
      db.prepare('SELECT count(*) AS n FROM media_voice_suggestions').get(),
    ).toEqual({ n: 1 });
    expect(db.prepare('PRAGMA foreign_keys').get()).toEqual({
      foreign_keys: 1,
    });
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });

  it('takes the new failure and still refuses an unknown one', () => {
    const db = migrated();
    const update = db.prepare(
      "UPDATE media_proposal_runs SET failure = ? WHERE id = 'run-1'",
    );
    update.run('accepted-limit');
    expect(() => update.run('timeout')).toThrow(/CHECK/);
  });

  it('keeps the indexes, the single running run among them', () => {
    const db = migrated();
    const indexes = db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type = 'index'
         AND tbl_name = 'media_proposal_runs' AND sql IS NOT NULL ORDER BY name`,
      )
      .all()
      .map((row) => row['name']);
    expect(indexes).toEqual([
      'media_proposal_runs_by_media',
      'media_proposal_runs_running',
    ]);
  });

  it('a deleted recording still takes its runs and draft along', () => {
    const db = migrated();
    db.prepare('DELETE FROM media WHERE id = ?').run(MEDIA_ID);
    expect(
      db.prepare('SELECT count(*) AS n FROM media_draft_tracks').get(),
    ).toEqual({ n: 0 });
  });

  it('has nothing to rebuild once the failure is accepted', () => {
    const db = migrated();
    expect(rebuildRunsAcceptingLimit(db)).toBe('');
  });

  it('refuses a runs table with no failure check to extend', () => {
    const db = new DatabaseSync(':memory:');
    db.exec('CREATE TABLE media_proposal_runs (id TEXT, failure TEXT)');
    expect(() => rebuildRunsAcceptingLimit(db)).toThrow(/no failure check/);
  });

  it('rolls a rebuild back when it leaves a broken key, and turns the keys on again', () => {
    const db = new DatabaseSync(':memory:');
    db.exec('PRAGMA foreign_keys = ON');
    applyMigrations(db, MEDIA_MIGRATIONS);
    const broken: Migration = {
      version: 900,
      name: 'broken-rebuild',
      rebuildsReferenced: true,
      sql: `INSERT INTO media_draft_tracks (id, media_id, run_id, source, first_segment,
          last_segment, start_ms, end_ms, kind, title, created_at)
        VALUES ('orphan', 'none', 'none', 'ai', 1, 2, 0, 9000, 'qa', 'Tema', '${AT}');`,
    };
    expect(() => applyMigrations(db, [...MEDIA_MIGRATIONS, broken])).toThrow(
      /broken foreign keys/,
    );
    expect(
      db.prepare('SELECT count(*) AS n FROM media_draft_tracks').get(),
    ).toEqual({ n: 0 });
    expect(db.prepare('PRAGMA foreign_keys').get()).toEqual({
      foreign_keys: 1,
    });
  });

  it('leaves the keys off on a database that had them off', () => {
    const db = new DatabaseSync(':memory:');
    db.exec('PRAGMA foreign_keys = OFF');
    applyMigrations(db, MEDIA_MIGRATIONS);
    expect(db.prepare('PRAGMA foreign_keys').get()).toEqual({
      foreign_keys: 0,
    });
  });
});
