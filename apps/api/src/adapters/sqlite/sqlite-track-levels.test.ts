import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { applyMigrations } from './media-database.js';
import { MEDIA_MIGRATIONS } from './media-migrations.js';
import { SqliteMediaEditStore } from './sqlite-media-edit-store.js';
import { hiddenClause } from './sqlite-media-search.js';
import { SqliteMediaStore } from './sqlite-media-store.js';

const AT = '2026-11-11T12:00:00.000Z';
const NOW = new Date(AT);

/** A CI recording with three tracks: t2 of its own at CDC; their draft rows with levels. */
function world() {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  applyMigrations(db, MEDIA_MIGRATIONS);
  const media = db.prepare(
    `INSERT INTO media (id, topic, title, authorship, owner_principal, file_name, upload_bytes,
       status, created_at, updated_at, parent_media_id, parent_start_ms, parent_end_ms, level,
       level_own)
     VALUES (?, 'hermetismo', ?, 'outros-autores', 'owner', 'a.mp3', 10, 'ready', ?, ?, ?, ?, ?, ?, ?)`,
  );
  media.run('r', 'Gravação', AT, AT, null, null, null, 'ci', 0);
  media.run('t1', 'Um', AT, AT, 'r', 0, 60_000, 'ci', 0);
  media.run('t2', 'Dois', AT, AT, 'r', 60_000, 120_000, 'cdc', 1);
  media.run('t3', 'Três', AT, AT, 'r', 120_000, 180_000, 'qs', 1);
  const track = db.prepare(
    `INSERT INTO media_tracks (id, media_id, ordinal, start_ms, end_ms, kind, title, source,
       approved_by, approved_at, derived_media_id)
     VALUES (?, 'r', ?, ?, ?, 'qa', ?, 'manual', 'owner', ?, ?)`,
  );
  track.run('k1', 1, 0, 60_000, 'Um', AT, 't1');
  track.run('k2', 2, 60_000, 120_000, 'Dois', AT, 't2');
  const draft = db.prepare(
    `INSERT INTO media_draft_tracks (id, media_id, source, start_ms, end_ms, kind, level, created_at)
     VALUES (?, 'r', 'manual', ?, ?, 'qa', ?, ?)`,
  );
  draft.run('k1', 0, 60_000, null, AT);
  draft.run('k2', 60_000, 120_000, 'cdc', AT);
  draft.run('k3', 120_000, 180_000, 'ci', AT);
  return {
    db,
    store: new SqliteMediaStore(db),
    edits: new SqliteMediaEditStore(db),
  };
}

const levels = (db: DatabaseSync) =>
  db
    .prepare('SELECT id, level, level_own FROM media ORDER BY id')
    .all()
    .map((row) => [row['id'], row['level'], row['level_own']]);
const draftLevels = (db: DatabaseSync) =>
  db
    .prepare('SELECT id, level FROM media_draft_tracks ORDER BY id')
    .all()
    .map((row) => [row['id'], row['level']]);

const edit = (
  level: string | null,
  tracks: { below: string[]; newScale: boolean },
) => ({
  mediaId: 'r',
  title: 'Gravação',
  topic: 'hermetismo',
  author: null,
  legacyAuthorship: 'outros-autores' as const,
  level,
  tracks,
  now: NOW,
});

describe('track levels in media.db (KBC-106)', () => {
  it('BR-1: a raised recording moves its followers and lifts its own tracks under it', () => {
    const { db, store } = world();
    const edited = store.editMedia(
      edit('cdc', { below: ['qs', 'ci'], newScale: false }),
    );
    expect(edited?.tracksRelevelled).toBe(2);
    expect(levels(db)).toEqual([
      ['r', 'cdc', 0],
      ['t1', 'cdc', 0],
      ['t2', 'cdc', 1],
      ['t3', 'cdc', 1],
    ]);
    // The draft rows under the new level follow it.
    expect(draftLevels(db)).toEqual([
      ['k1', null],
      ['k2', 'cdc'],
      ['k3', 'cdc'],
    ]);
  });

  it('a recording lowered keeps the tracks of their own where they are', () => {
    const { db, store } = world();
    store.editMedia(edit('qs', { below: [], newScale: false }));
    expect(levels(db)).toEqual([
      ['r', 'qs', 0],
      ['t1', 'qs', 0],
      ['t2', 'cdc', 1],
      ['t3', 'qs', 1],
    ]);
  });

  it('in another scale every track takes the new level and follows again', () => {
    const { db, store } = world();
    store.editMedia(edit('a1', { below: [], newScale: true }));
    expect(levels(db).map(([, level, own]) => [level, own])).toEqual([
      ['a1', 0],
      ['a1', 0],
      ['a1', 0],
      ['a1', 0],
    ]);
    expect(draftLevels(db).map(([, level]) => level)).toEqual([
      null,
      null,
      null,
    ]);
  });

  it("FR-1: a track's level set and back, its draft row following", () => {
    const { db, store } = world();
    store.setTrackLevel({ mediaId: 't1', level: 'cdc', own: true, now: NOW });
    expect(levels(db)[1]).toEqual(['t1', 'cdc', 1]);
    expect(draftLevels(db)[0]).toEqual(['k1', 'cdc']);
    store.setTrackLevel({ mediaId: 't1', level: 'ci', own: false, now: NOW });
    expect(levels(db)[1]).toEqual(['t1', 'ci', 0]);
    expect(draftLevels(db)[0]).toEqual(['k1', null]);
  });

  it('reads the levels a recording needs: its live tracks, their own, one by id', () => {
    const { store, edits } = world();
    // Published ones by their real bounds, and approved ones by their asked bounds (m4).
    expect(store.liveTrackLevels('r').map((one) => one.level)).toEqual([
      'ci',
      'ci',
      'cdc',
      'cdc',
      'qs',
    ]);
    expect(store.ownTrackLevels('r')).toEqual(['cdc', 'qs']);
    expect(store.levelOf('t2')).toBe('cdc');
    expect(store.levelOf('nope')).toBeUndefined();
    expect([...edits.approvedLevels('r')]).toEqual([
      ['k1', 'ci'],
      ['k2', 'cdc'],
    ]);
  });

  it('a scale taken away clears what was a level of its own', () => {
    const { db, store } = world();
    store.relevel({ topics: ['hermetismo'], to: null });
    expect(
      levels(db).every(([, level, own]) => level === null && own === 0),
    ).toBe(true);
  });
});

describe('the hidden clause of a segment query (KBC-106 BR-2)', () => {
  it('is always true when every collection sees every level, or none is asked', () => {
    expect(hiddenClause(undefined).sql).toBe('1');
    expect(hiddenClause(new Map([['a', null]])).sql).toBe('1');
  });

  it('names what each collection sees, and sees nothing where no level is held', () => {
    const clause = hiddenClause(
      new Map<string, readonly string[] | null>([
        ['a', ['qs', 'ci']],
        ['b', null],
        ['c', []],
      ]),
    );
    expect(clause.sql).toContain('NOT EXISTS');
    // Once for the published tracks, once for the approved ones (review m4).
    expect(clause.values).toEqual(['a', 'qs', 'ci', 'b', 'a', 'qs', 'ci', 'b']);
    const none = hiddenClause(new Map([['c', []]]));
    expect(none.sql).toContain('NOT (0)');
  });
});

describe('a scale change and its undo keep the tracks above their recordings (KBC-106 review M3)', () => {
  it("the undo puts back a track's own level", () => {
    const { db, store } = world();
    // Every level away (scale.clear) wipes the own levels; its undo brings them back.
    const moved = store.relevel({ topics: ['hermetismo'], to: null });
    expect(levels(db)[2]).toEqual(['t2', null, 0]);
    const back = moved.map((row) => ({ ...row, written: row.written ?? null }));
    expect(store.restoreLevels(back)).toEqual([]);
    expect(levels(db)[2]).toEqual(['t2', 'cdc', 1]);
  });

  it('a level taken away never leaves a track below its recording: it follows the recording', () => {
    const { db, store } = world();
    const moved = store.relevel({
      topics: ['hermetismo'],
      from: 'cdc',
      to: 'qs',
      order: ['qs', 'ci'],
    });
    expect(levels(db)[2]).toEqual(['t2', 'ci', 0]);
    expect(moved.find((row) => row.id === 't2')).toMatchObject({
      level: 'cdc',
      written: 'ci',
    });
    // t3 (QS, of its own, under a CI recording) is lifted too.
    expect(levels(db)[3]).toEqual(['t3', 'ci', 0]);
  });
});

describe('a new order of the scale (KBC-106 review M3)', () => {
  it('lifts a track it leaves below its recording, which then follows it', () => {
    const { db, store } = world();
    // CDC now ranks under CI: t2 (CDC) and t3 (QS) would sit below the CI recording.
    const lifted = store.liftTracks(['hermetismo'], ['qs', 'cdc', 'ci']);
    expect(lifted.map((row) => [row.id, row.level, row.written])).toEqual([
      ['t2', 'cdc', 'ci'],
      ['t3', 'qs', 'ci'],
    ]);
    expect(levels(db).slice(2)).toEqual([
      ['t2', 'ci', 0],
      ['t3', 'ci', 0],
    ]);
  });
});
