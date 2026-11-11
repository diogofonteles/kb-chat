import type { DatabaseSync } from 'node:sqlite';
import { beforeEach, describe, expect, it } from 'vitest';
import { inTransaction, openMediaDatabase } from './media-database.js';
import { MEDIA_MIGRATIONS } from './media-migrations.js';
import { SqliteMediaSearch } from './sqlite-media-search.js';

const NOW = '2026-11-04T00:00:00.000Z';
const RANKED = 10_000;

interface TrackRow {
  readonly id: string;
  readonly topic?: string;
  readonly status?: string;
  readonly archivedAt?: string | null;
  readonly author?: string | null;
  readonly durationMs?: number | null;
  readonly createdAt?: string;
}

function insertRecording(db: DatabaseSync): void {
  db.prepare(
    `INSERT INTO media (id, topic, title, authorship, owner_principal, file_name, upload_bytes,
       status, created_at, updated_at)
     VALUES ('rec', 'udv', 'Palestra', 'outros-autores', 'owner', 'a.m4a', 1, 'ready', ?, ?)`,
  ).run(NOW, NOW);
}

function insertTrack(db: DatabaseSync, track: TrackRow): void {
  db.prepare(
    `INSERT INTO media (id, topic, title, authorship, author, owner_principal, file_name,
       upload_bytes, status, duration_ms, archived_at, created_at, updated_at, parent_media_id,
       parent_start_ms, parent_end_ms)
     VALUES (?, ?, ?, 'outros-autores', ?, 'owner', 'a.m4a', 1, ?, ?, ?, ?, ?, 'rec', 0, 1000)`,
  ).run(
    track.id,
    track.topic ?? 'udv',
    `Faixa ${track.id}`,
    track.author ?? null,
    track.status ?? 'ready',
    track.durationMs === undefined ? 60_000 : track.durationMs,
    track.archivedAt ?? null,
    track.createdAt ?? NOW,
    NOW,
  );
}

function link(db: DatabaseSync, mediaId: string, name: string): void {
  db.prepare(
    `INSERT INTO media_subject_links (id, media_id, kind, subject_key, concept_name, source,
       status, created_at)
     VALUES (?, ?, 'concept', ?, ?, 'manual', 'accepted', ?)`,
  ).run(
    `${mediaId}-${name}`,
    mediaId,
    `concept:${name.toLowerCase()}`,
    name,
    NOW,
  );
}

function say(
  db: DatabaseSync,
  mediaId: string,
  texts: readonly string[],
): void {
  db.prepare(
    `INSERT INTO transcripts (id, media_id, version, provider, model, parameters,
       parameters_version, terms_version, vad, speech_ratio, elapsed_ms, raw_path,
       filter_version, confidence_version, confidence, word_count, removed_words,
       low_words, created_at)
     VALUES (?, ?, 1, 'mlx-whisper', 'synthetic', '{}', '1', 1, 'applied', 1, 0, 'r.json',
       1, 1, 'normal', 0, 0, 0, ?)`,
  ).run(`t-${mediaId}`, mediaId, NOW);
  const segment = db.prepare(
    `INSERT INTO segments (transcript_id, position, start_ms, end_ms, text)
     VALUES (?, ?, ?, ?, ?)`,
  );
  for (const [position, text] of texts.entries())
    segment.run(
      `t-${mediaId}`,
      position,
      position * 1000,
      position * 1000 + 900,
      text,
    );
  db.prepare(
    `INSERT INTO segments_fts (rowid, text)
     SELECT rowid, text FROM segments WHERE transcript_id = ?`,
  ).run(`t-${mediaId}`);
}

describe('SqliteMediaSearch over tracks (KBC-070)', () => {
  let db: DatabaseSync;
  let search: SqliteMediaSearch;

  beforeEach(() => {
    db = openMediaDatabase(':memory:', MEDIA_MIGRATIONS);
    search = new SqliteMediaSearch(db);
    insertRecording(db);
  });

  it('answers nothing, without asking, for no collection or no words', () => {
    expect(search.linkedTracks({ topics: [] })).toEqual([]);
    expect(search.speakingTracks([], ['a'])).toEqual([]);
    expect(search.speakingTracks(['chá'], [])).toEqual([]);
    expect(search.bestPassages([], ['a'])).toEqual([]);
    expect(search.bestPassages(['chá'], [])).toEqual([]);
    expect(search.tracksAbout([])).toEqual(new Set());
    expect(search.saying([])).toEqual(new Set());
    expect(
      search.subjectCounts({ topics: [], authors: { kind: 'any' } }),
    ).toEqual([]);
  });

  it('lists only published tracks with a link, newest first, in the collections asked', () => {
    insertTrack(db, { id: 'old', createdAt: '2026-01-01T00:00:00.000Z' });
    insertTrack(db, { id: 'new', author: 'ana' });
    insertTrack(db, { id: 'bare' });
    insertTrack(db, { id: 'cutting', status: 'queued' });
    insertTrack(db, { id: 'gone', archivedAt: NOW });
    insertTrack(db, { id: 'elsewhere', topic: 'alquimia' });
    for (const id of ['old', 'new', 'cutting', 'gone', 'elsewhere'])
      link(db, id, 'Cabala');

    expect(search.linkedTracks({ topics: ['udv'] })).toEqual([
      { mediaId: 'new', topic: 'udv', author: 'ana' },
      { mediaId: 'old', topic: 'udv', author: null },
    ]);
    expect(search.linkedTracks({ topics: ['udv'], ids: ['old'] })).toHaveLength(
      1,
    );
    expect(
      search.subjectCounts({ topics: ['udv'], authors: { kind: 'any' } }),
    ).toEqual([{ key: 'concept:cabala', tracks: 2 }]);
    expect(
      search.subjectCounts({
        topics: ['udv'],
        authors: { kind: 'any' },
        ids: ['old'],
      }),
    ).toEqual([{ key: 'concept:cabala', tracks: 1 }]);
  });

  it('finds the words only in the segment of the track that says them', () => {
    insertTrack(db, { id: 'one' });
    insertTrack(db, { id: 'two' });
    link(db, 'one', 'Cabala');
    link(db, 'two', 'Cabala');
    say(db, 'one', ['o chá da sessão', 'outra frase']);
    say(db, 'two', ['nada aqui', 'chá', 'sessão']);

    expect(search.speakingTracks(['chá', 'sessão'], ['one', 'two'])).toEqual([
      'one',
    ]);
    expect(
      search.bestPassages(['chá'], ['one', 'two']).map((one) => one.mediaId),
    ).toEqual(['one', 'two']);
    expect(search.saying(['chá'])).toEqual(new Set(['one', 'two']));
  });

  it('leaves a word past the ranking limit unranked and uncounted', () => {
    insertTrack(db, { id: 'one' });
    link(db, 'one', 'Cabala');
    inTransaction(db, () =>
      say(
        db,
        'one',
        Array.from({ length: RANKED + 1 }, () => 'vegetal'),
      ),
    );

    expect(search.saying(['vegetal'])).toBeNull();
    const [best] = search.bestPassages(['vegetal'], ['one']);
    expect(best).toMatchObject({ mediaId: 'one', startMs: 0, bm25: -1 });
  });

  it('reads only the passages that will show for a word past the limit', () => {
    const ids = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];
    for (const id of ids) insertTrack(db, { id });
    inTransaction(db, () => {
      for (const id of ids)
        say(
          db,
          id,
          Array.from(
            { length: Math.ceil(RANKED / ids.length) + 1 },
            () => 'vegetal',
          ),
        );
    });

    expect(
      search.bestPassages(['vegetal'], ids).map((one) => one.mediaId),
    ).toEqual(['a', 'b', 'c', 'd', 'e']);
  });

  it('gives a track with no author, length or summary as it is, in the order asked', () => {
    insertTrack(db, { id: 'a', durationMs: null });
    insertTrack(db, { id: 'b', author: 'ana' });
    db.prepare(
      `INSERT INTO media_track_subjects (media_id, summary, updated_at)
       VALUES ('b', 'Sobre o chá', ?)`,
    ).run(NOW);

    expect(search.trackDetails(['b', 'missing', 'a'])).toEqual([
      {
        mediaId: 'b',
        topic: 'udv',
        title: 'Faixa b',
        author: 'ana',
        durationMs: 60_000,
        summary: 'Sobre o chá',
        parentTitle: 'Palestra',
      },
      {
        mediaId: 'a',
        topic: 'udv',
        title: 'Faixa a',
        author: null,
        durationMs: null,
        summary: null,
        parentTitle: 'Palestra',
      },
    ]);
    expect(search.tracksAbout(['cha'])).toEqual(new Set(['b']));
  });
});

describe('spokenAmong and passagesAt (KBC-096)', () => {
  let db: DatabaseSync;
  let search: SqliteMediaSearch;

  beforeEach(() => {
    db = openMediaDatabase(':memory:', MEDIA_MIGRATIONS);
    search = new SqliteMediaSearch(db);
    insertRecording(db);
    insertTrack(db, { id: 'one' });
    insertTrack(db, { id: 'two' });
    inTransaction(db, () => {
      say(db, 'one', ['palavra rara', 'outra coisa', 'palavra rara rara']);
      say(db, 'two', ['nada aqui', 'palavra rara uma vez']);
    });
  });

  const spoken = (ids: readonly string[], terms = ['rara'], limit = 10) =>
    search.spokenAmong({ terms, ids, tracks: true, limit });

  it('gives each media once, at its best passage, and only those asked', () => {
    const { places, more } = spoken(['one', 'two']);
    expect(places.map((one) => one.mediaId).sort()).toEqual(['one', 'two']);
    expect(more).toBe(false);
    const [passage] = search.passagesAt(
      ['rara'],
      places.filter((one) => one.mediaId === 'one').map((one) => one.place),
    );
    expect(passage).toMatchObject({ mediaId: 'one', startMs: 2000 });
    expect(passage?.marked).toContain('\u0002rara\u0003');
    expect(spoken(['two']).places.map((one) => one.mediaId)).toEqual(['two']);
  });

  it('marks each place with its own text, not the first one read', () => {
    const { places } = spoken(['one', 'two']);
    const passages = search.passagesAt(
      ['rara'],
      places.map((one) => one.place),
    );
    const textOf = (id: string) =>
      passages.find((one) => one.mediaId === id)?.marked;
    expect(textOf('one')).toBe('palavra \u0002rara\u0003 \u0002rara\u0003');
    expect(textOf('two')).toBe('palavra \u0002rara\u0003 uma vez');
  });

  it('says when more media hold the words than the limit', () => {
    const { places, more } = spoken(['one', 'two'], ['rara'], 1);
    expect(places).toHaveLength(1);
    expect(more).toBe(true);
  });

  it('answers nothing without words or media', () => {
    expect(spoken([])).toEqual({ places: [], more: false });
    expect(spoken(['one'], [])).toEqual({ places: [], more: false });
    expect(search.passagesAt([], [1])).toEqual([]);
  });

  it('reads media one stretch at a time past RANKED, the normal confidence first', () => {
    const ids = Array.from({ length: 3 }, (_, i) => `many-${i}`);
    inTransaction(db, () => {
      for (const id of ids) {
        insertTrack(db, { id });
        say(
          db,
          id,
          Array.from({ length: RANKED / 2 }, () => 'comum'),
        );
      }
    });
    db.prepare(`UPDATE transcripts SET confidence = 'low' WHERE id = ?`).run(
      't-many-0',
    );

    const { places, more } = spoken(ids, ['comum'], 2);

    expect(places.map((one) => one.mediaId)).toEqual(['many-1', 'many-2']);
    expect(more).toBe(true);
    const all = spoken(ids, ['comum'], 10);
    expect(all.places.at(-1)?.mediaId).toBe('many-0');
    expect(all.more).toBe(false);
  });

  it('past RANKED, a recording speaks only outside its tracks', () => {
    inTransaction(db, () => {
      say(db, 'rec', ['comum dentro da faixa']);
      insertTrack(db, { id: 'bulk' });
      say(
        db,
        'bulk',
        Array.from({ length: RANKED + 1 }, () => 'comum'),
      );
    });
    expect(
      spoken(['rec', 'bulk'], ['comum']).places.map((one) => one.mediaId),
    ).toEqual(['bulk']);
  });
});
