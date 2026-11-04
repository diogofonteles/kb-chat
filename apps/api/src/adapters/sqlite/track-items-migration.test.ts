import { MEDIA_JOB_KINDS } from '@kb-chat/contracts';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { applyMigrations } from './media-database.js';
import { MEDIA_MIGRATIONS, type Migration } from './media-migrations.js';

const MEDIA_ID = '68686868-6868-4868-8868-686868686868';
const AT = '2026-11-04T10:00:00.000Z';
/** This item's migration, found by name: its number may change on a rebase. */
const VERSION =
  MEDIA_MIGRATIONS.find((one) => one.name === 'track-items')?.version ?? 0;
const BEFORE = MEDIA_MIGRATIONS.filter((one) => one.version < VERSION);

/** What KBC-071's unmerged migration does to `jobs`: a kind, a column and a check. */
const SIBLING_REBUILD: Migration = {
  version: VERSION - 1,
  name: 'sibling-rebuild',
  sql: `
    CREATE TABLE jobs_sibling (
      id TEXT PRIMARY KEY,
      media_id TEXT NOT NULL REFERENCES media (id) ON DELETE CASCADE,
      kind TEXT NOT NULL
        CHECK (kind IN
          ('transcode', 'transcribe', 'silences', 'diarize', 'waveform', 'voice-profile')),
      status TEXT NOT NULL CHECK (status IN ('queued', 'leased', 'done', 'failed', 'dead')),
      attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
      lease_id TEXT, lease_until INTEGER, heartbeat_at INTEGER, worker TEXT, error TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      detector_version INTEGER, voices INTEGER,
      voice_profile_id TEXT,
      CHECK ((kind = 'voice-profile') = (voice_profile_id IS NOT NULL))
    ) STRICT;
    INSERT INTO jobs_sibling (id, media_id, kind, status, attempts, created_at, updated_at,
      voices) SELECT id, media_id, kind, status, attempts, created_at, updated_at, voices FROM jobs;
    DROP TABLE jobs;
    ALTER TABLE jobs_sibling RENAME TO jobs;
    CREATE INDEX jobs_queued ON jobs (kind, created_at) WHERE status = 'queued';
    CREATE INDEX jobs_by_voice_profile ON jobs (voice_profile_id)
      WHERE voice_profile_id IS NOT NULL;
  `,
};

/**
 * KBC-045's unmerged migration, word for word (PR #72): it creates `words_by_segment` with no
 * `IF NOT EXISTS`, and may reach a database before or after this one.
 */
const WORD_HIGHLIGHT: Migration = {
  version: 16,
  name: 'word-highlight',
  sql: `
    CREATE INDEX words_by_segment ON words (transcript_id, segment_position, position);
    ALTER TABLE media_preferences ADD COLUMN word_highlight INTEGER NOT NULL DEFAULT 1
      CHECK (word_highlight IN (0, 1));
  `,
};
/** This code's list without KBC-045's, so these tests outlive that merge. */
const OURS = MEDIA_MIGRATIONS.filter((one) => one.name !== 'word-highlight');
const OURS_BEFORE = OURS.filter((one) => one.version < VERSION);

const appliedVersions = (db: DatabaseSync) =>
  db
    .prepare('SELECT version FROM schema_migrations')
    .all()
    .map((row) => row['version']);

const indexesOfWords = (db: DatabaseSync) =>
  db
    .prepare(
      `SELECT name FROM sqlite_master
       WHERE type = 'index' AND tbl_name = 'words' AND sql IS NOT NULL ORDER BY name`,
    )
    .all()
    .map((row) => row['name']);

/** PR #72's query: its panel pages a transcript's words in order, without sorting them. */
const planOfWordPage = (db: DatabaseSync) =>
  db
    .prepare(
      `EXPLAIN QUERY PLAN SELECT start_ms FROM words
       WHERE transcript_id = 't' AND segment_position >= 100 AND segment_position < 200
       ORDER BY segment_position, position`,
    )
    .all()
    .map((row) => String(row['detail']))
    .join(' ');

function seeded(migrations: readonly Migration[]): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  applyMigrations(db, migrations);
  db.prepare(
    `INSERT INTO media (id, topic, title, authorship, owner_principal, file_name,
       upload_bytes, status, created_at, updated_at)
     VALUES (?, 'hermetismo', 'Palestra', 'outros-autores', 'owner', 'a.mp3', 3, 'ready', ?, ?)`,
  ).run(MEDIA_ID, AT, AT);
  db.prepare(
    `INSERT INTO jobs (id, media_id, kind, status, attempts, created_at, updated_at, voices)
     VALUES ('job-1', ?, 'diarize', 'queued', 2, ?, ?, 3)`,
  ).run(MEDIA_ID, AT, AT);
  return db;
}

const insertJob = (db: DatabaseSync, id: string, kind: string) =>
  db
    .prepare(
      `INSERT INTO jobs (id, media_id, kind, status, created_at, updated_at)
       VALUES (?, ?, ?, 'queued', ?, ?)`,
    )
    .run(id, MEDIA_ID, kind, AT, AT);

const indexesOfJobs = (db: DatabaseSync) =>
  db
    .prepare(
      `SELECT name FROM sqlite_master
       WHERE type = 'index' AND tbl_name = 'jobs' AND sql IS NOT NULL ORDER BY name`,
    )
    .all()
    .map((row) => row['name']);

describe('migration track-items (KBC-068)', () => {
  it('keeps every job and index and takes every kind of the contract', () => {
    const db = seeded(BEFORE);
    applyMigrations(db, MEDIA_MIGRATIONS);
    expect(db.prepare('SELECT kind, attempts, voices FROM jobs').get()).toEqual(
      { kind: 'diarize', attempts: 2, voices: 3 },
    );
    expect(indexesOfJobs(db)).toEqual([
      'jobs_by_media',
      'jobs_by_voice_profile',
      'jobs_by_worker',
      'jobs_leased',
      'jobs_queued',
    ]);
    // A later migration may need columns for its kind (voice-profile): the rule is the CHECK.
    const kinds = MEDIA_JOB_KINDS.filter(
      (kind) => String(kind) !== 'voice-profile',
    );
    kinds.forEach((kind, index) => insertJob(db, `new-${index}`, kind));
    expect(() => insertJob(db, 'nope', 'unknown')).toThrow(/CHECK/);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    db.close();
  });

  it('keeps what a sibling rebuild of jobs added, on top of it', () => {
    const db = seeded([...BEFORE, SIBLING_REBUILD]);
    applyMigrations(db, [...BEFORE, SIBLING_REBUILD, ...MEDIA_MIGRATIONS]);
    insertJob(db, 'a-cut', 'cut');
    db.prepare(
      `INSERT INTO jobs (id, media_id, kind, status, created_at, updated_at, voice_profile_id)
       VALUES ('voice', ?, 'voice-profile', 'queued', ?, ?, 'profile-1')`,
    ).run(MEDIA_ID, AT, AT);
    expect(() => insertJob(db, 'no-profile', 'voice-profile')).toThrow(/CHECK/);
    expect(indexesOfJobs(db)).toContain('jobs_by_voice_profile');
    db.close();
  });

  it('does not rebuild a jobs table that already takes the kind', () => {
    const accepting: Migration = {
      ...SIBLING_REBUILD,
      sql: `ALTER TABLE jobs RENAME TO jobs_old;
        CREATE TABLE jobs (id TEXT PRIMARY KEY, media_id TEXT, kind TEXT
          CHECK (kind IN ('diarize', 'cut')), status TEXT, attempts INTEGER,
          created_at TEXT, updated_at TEXT, voices INTEGER);
        DROP TABLE jobs_old;`,
    };
    const db = seeded([...BEFORE, accepting]);
    applyMigrations(db, [...BEFORE, accepting, ...MEDIA_MIGRATIONS]);
    expect(db.prepare('SELECT count(*) AS n FROM jobs').get()).toEqual({
      n: 1,
    });
    db.close();
  });

  describe.each([
    {
      state: 'a database at word-highlight meets this migration',
      steps: [[...OURS_BEFORE, WORD_HIGHLIGHT], OURS],
    },
    {
      state: 'a database past this migration gets word-highlight',
      steps: [OURS, [...OURS, WORD_HIGHLIGHT]],
    },
    {
      state: 'a new database takes both',
      steps: [[...OURS, WORD_HIGHLIGHT]],
    },
  ])('when $state', ({ steps }) => {
    const migrated = () => {
      const db = new DatabaseSync(':memory:');
      steps.forEach((list) => applyMigrations(db, list));
      return db;
    };

    it('applies both and keeps the index of each', () => {
      const db = migrated();
      expect(appliedVersions(db)).toEqual(
        expect.arrayContaining([WORD_HIGHLIGHT.version, VERSION]),
      );
      expect(indexesOfWords(db)).toEqual([
        'words_by_segment',
        'words_by_segment_position',
      ]);
      db.close();
    });

    it("reads a page of words through a segment index, in the index's order", () => {
      const db = migrated();
      const plan = planOfWordPage(db);
      expect(plan).toContain('words_by_segment');
      expect(plan).not.toContain('TEMP B-TREE');
      db.close();
    });
  });

  it("serves a page of words in order from this migration's index alone", () => {
    const db = new DatabaseSync(':memory:');
    applyMigrations(db, OURS);
    expect(indexesOfWords(db)).toEqual(['words_by_segment_position']);
    expect(planOfWordPage(db)).not.toContain('TEMP B-TREE');
    db.close();
  });

  it('gives a track the media row of its recording to cascade from', () => {
    const db = seeded(BEFORE);
    applyMigrations(db, MEDIA_MIGRATIONS);
    db.prepare(
      `INSERT INTO media (id, topic, title, authorship, owner_principal, file_name, upload_bytes,
         status, created_at, updated_at, parent_media_id, parent_start_ms, parent_end_ms)
       VALUES ('track', 'hermetismo', 'Faixa', 'outros-autores', 'owner', 'a.m4a', 1, 'queued',
         ?, ?, ?, 0, 5000)`,
    ).run(AT, AT, MEDIA_ID);
    db.prepare('DELETE FROM media WHERE id = ?').run(MEDIA_ID);
    expect(db.prepare('SELECT count(*) AS n FROM media').get()).toEqual({
      n: 0,
    });
    db.close();
  });
});
