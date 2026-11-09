import { describe, expect, it } from 'vitest';
import type { CorrectionRow } from '../../ports/transcript-correction-store.js';
import { openMediaDatabase } from './media-database.js';
import { MEDIA_MIGRATIONS } from './media-migrations.js';
import { SqliteTranscriptCorrectionStore } from './sqlite-transcript-correction-store.js';
import { SqliteTranscriptStore } from './sqlite-transcript-store.js';

const AT = '2026-11-09T10:00:00.000Z';

/** A media with one transcript saying `words` in one segment. */
function world(words: readonly string[]) {
  const db = openMediaDatabase(':memory:', MEDIA_MIGRATIONS);
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
  const insert = db.prepare(
    `INSERT INTO words (transcript_id, position, segment_position, start_ms, end_ms, text)
     VALUES ('t1', ?, 0, ?, ?, ?)`,
  );
  words.forEach((text, at) => insert.run(at, at * 400, (at + 1) * 400, text));
  return {
    db,
    store: new SqliteTranscriptCorrectionStore(db),
    terms: new SqliteTranscriptStore(db),
  };
}

let ids = 0;
const row = (overrides: Partial<CorrectionRow> = {}): CorrectionRow => ({
  id: `c${++ids}`,
  mediaId: 'rec',
  transcriptId: 't1',
  version: 1,
  revision: 1,
  kind: 'correct',
  position: 2,
  count: 1,
  segment: 0,
  startMs: 800,
  endMs: 1200,
  before: ['Tiuako'],
  after: 'Tiuaco',
  reverts: null,
  state: 'active',
  carriedTo: null,
  checkedVersion: null,
  found: null,
  groupId: null,
  ruleId: null,
  authorPrincipal: 'owner',
  authorName: 'Dono',
  createdAt: AT,
  ...overrides,
});

describe('SqliteTranscriptCorrectionStore: learning (KBC-113)', () => {
  it('a source carries its neighbours; a span corrected twice counts once, from the first text', () => {
    const { store } = world(['o', 'mestre', 'Tiuacu', 'disse']);
    store.insert(row({ id: 'first', before: ['Tiuako'], after: 'Tiuacu' }));
    store.insert(
      row({
        id: 'second',
        before: ['Tiuacu'],
        after: 'Tiuaco',
        createdAt: '2026-11-09T11:00:00.000Z',
      }),
    );

    expect(store.learningSources()).toEqual([
      expect.objectContaining({
        id: 'second',
        before: ['Tiuako'],
        after: 'Tiuaco',
        contextBefore: 'mestre',
        contextAfter: 'disse',
        mediaTitle: 'Palestra',
      }),
    ]);
  });

  it('follows a carried correction: in force while its chain is, out once undone', () => {
    const { store } = world(['Tiuako']);
    store.insert(row({ id: 'kept', state: 'carried', carriedTo: 'k2' }));
    store.insert(
      row({ id: 'k2', kind: 'carried', state: 'active', position: 9 }),
    );
    store.insert(
      row({ id: 'gone', state: 'carried', carriedTo: 'g2', position: 5 }),
    );
    store.insert(
      row({ id: 'g2', kind: 'carried', state: 'undone', position: 6 }),
    );
    store.insert(
      row({ id: 'lost', state: 'carried', carriedTo: 'nowhere', position: 7 }),
    );
    store.insert(
      row({ id: 'loop', state: 'carried', carriedTo: 'l2', position: 10 }),
    );
    store.insert(
      row({
        id: 'l2',
        kind: 'carried',
        state: 'carried',
        carriedTo: 'l2',
        position: 11,
      }),
    );
    store.insert(row({ id: 'deleted', after: '', position: 8 }));
    store.insert(row({ id: 'undone', state: 'undone', position: 3 }));

    expect(
      store
        .learningSources()
        .map((one) => one.id)
        .sort(),
    ).toEqual(['kept', 'loop', 'lost']);
  });

  it('tallies the learning rows of each rule, and the carried positions', () => {
    const { store } = world(['a']);
    store.insert(row({ ruleId: 'r1', authorName: null }));
    store.insert(row({ ruleId: 'r1', state: 'undone', position: 4 }));
    store.insert(row({ kind: 'carried', position: 6, count: 2 }));

    expect(store.ruleTallies().get('r1')).toEqual({ applied: 2, undone: 1 });
    expect([...store.carriedPositions('t1')].sort()).toEqual([6, 7]);
    expect(store.learnedOn('t1', { from: 0, count: 1 })).toEqual([
      expect.objectContaining({ position: 2, count: 1, before: 'Tiuako' }),
    ]);
    expect(store.learnedOn('t1', { from: 1, count: 1 })).toEqual([]);
  });

  it('a switch is set, changed and removed', () => {
    const { store } = world(['a']);
    const author = { principal: 'owner', name: null };
    const now = new Date(AT);
    store.setSwitch({ kind: 'rule', key: 'k', enabled: false, author, now });
    store.setSwitch({ kind: 'rule', key: 'k', enabled: true, author, now });
    expect(store.switches().get('rule:k')).toEqual({
      enabled: true,
      authorName: null,
      at: AT,
    });
    store.setSwitch({ kind: 'rule', key: 'k', enabled: null, author, now });
    expect(store.switches().size).toBe(0);
  });

  it('a term-list version keeps the masters terms apart from the learned ones', () => {
    const { terms } = world(['a']);
    const current = terms.currentTerms();
    expect(terms.termPartsAt(999)).toBeNull();

    terms.saveTerms({
      baseVersion: current.version,
      terms: ['Hoasca'],
      learned: ['Atlântida'],
      author: { principal: 'system:learning', name: 'Aprendizado' },
      now: new Date(AT),
    });

    expect(terms.currentTerms().terms).toEqual(['Hoasca', 'Atlântida']);
    expect(terms.termPartsAt(current.version + 1)).toEqual({
      version: current.version + 1,
      manual: ['Hoasca'],
      learned: ['Atlântida'],
    });
  });
});
