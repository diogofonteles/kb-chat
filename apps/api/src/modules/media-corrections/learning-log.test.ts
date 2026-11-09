import { describe, expect, it } from 'vitest';
import type { LearningLogRow } from '../../ports/transcript-correction-store.js';
import { readLog } from './learning-log.js';

let next = 0;

/** A log row as the store gives it, oldest first. */
const row = (overrides: Partial<LearningLogRow> = {}): LearningLogRow => ({
  id: `r${++next}`,
  mediaId: 'm1',
  mediaTitle: 'Palestra',
  transcriptId: 't1',
  kind: 'correct',
  position: 2,
  count: 2,
  startMs: 1000,
  before: ['a', 'Manta'],
  after: 'Atlântida',
  state: 'active',
  carriedTo: null,
  ruleId: null,
  contextBefore: 'com',
  contextAfter: 'foi',
  createdAt: `2026-11-09T10:00:${String(next).padStart(2, '0')}.000Z`,
  authorName: 'Maria',
  ...overrides,
});

const sourcesOf = (rows: LearningLogRow[]) =>
  readLog(rows).sources.map((one) => [one.id, one.before.join(' '), one.after]);

describe('readLog (KBC-113 BR-1, BR-8; review round 1)', () => {
  it('a person correction in force teaches, with its context', () => {
    const taught = row();
    expect(readLog([taught]).sources).toEqual([
      expect.objectContaining({
        id: taught.id,
        before: ['a', 'Manta'],
        after: 'Atlântida',
        contextBefore: 'com',
        contextAfter: 'foi',
      }),
    ]);
  });

  it('(a) correcting over a learned replacement counts against its rule and teaches from what the transcriber said', () => {
    const learned = row({
      transcriptId: 't2',
      ruleId: 'rule1',
      authorName: 'Aprendizado das correções',
    });
    const over = row({
      transcriptId: 't2',
      position: 2,
      count: 1,
      before: ['Atlântida'],
      after: 'Amanta',
    });

    const read = readLog([learned, over]);

    expect(read.tallies.get('rule1')).toEqual({ applied: 1, undone: 1 });
    expect(sourcesOf([learned, over])).toEqual([
      [over.id, 'a Manta', 'Amanta'],
    ]);
    expect(read.overwritten.has(learned.id)).toBe(true);
  });

  it('only punctuation or case over a learned replacement is no undo', () => {
    const learned = row({ transcriptId: 't2', ruleId: 'rule1' });
    const comma = row({
      transcriptId: 't2',
      count: 1,
      before: ['Atlântida'],
      after: 'Atlântida,',
    });
    expect(readLog([learned, comma]).tallies.get('rule1')).toEqual({
      applied: 1,
      undone: 0,
    });
  });

  it('(b) a correction superseded by a wider one stops teaching; the wider one teaches from the first text', () => {
    const narrow = row({
      position: 3,
      count: 1,
      before: ['Manta'],
      after: 'Amanta',
    });
    const wide = row({
      position: 2,
      count: 2,
      before: ['a', 'Amanta'],
      after: 'Atlântida',
    });
    expect(sourcesOf([narrow, wide])).toEqual([
      [wide.id, 'a Manta', 'Atlântida'],
    ]);
  });

  it('(c) a correction carried to a new version and corrected again there teaches once, from that version', () => {
    const first = row({ state: 'carried', carriedTo: 'c1' });
    const carried = row({
      id: 'c1',
      kind: 'carried',
      transcriptId: 't2',
      before: ['a', 'Mantra'],
    });
    const again = row({
      transcriptId: 't2',
      before: ['Atlântida', ''],
      after: 'Atlântida antiga',
    });
    expect(sourcesOf([first, carried, again])).toEqual([
      [again.id, 'a Mantra', 'Atlântida antiga'],
    ]);
  });

  it('a carried correction still in force teaches through its original; one undone later does not', () => {
    const kept = row({ state: 'carried', carriedTo: 'k2' });
    const keptThere = row({ id: 'k2', kind: 'carried', transcriptId: 't2' });
    const gone = row({ state: 'carried', carriedTo: 'g2', position: 7 });
    const goneThere = row({
      id: 'g2',
      kind: 'carried',
      transcriptId: 't2',
      position: 7,
      state: 'undone',
    });
    const loop = row({ state: 'carried', carriedTo: 'l2', position: 12 });
    const loopThere = row({
      id: 'l2',
      kind: 'carried',
      transcriptId: 't3',
      position: 12,
      state: 'carried',
      carriedTo: 'l2',
    });
    expect(
      readLog([kept, keptThere, gone, goneThere, loop, loopThere])
        .sources.map((one) => one.id)
        .sort(),
    ).toEqual([kept.id, loop.id].sort());
  });

  it('an undone correction neither teaches nor supersedes', () => {
    const kept = row({ position: 3, count: 1, before: ['Manta'] });
    const undone = row({ state: 'undone', after: 'Outra' });
    expect(sourcesOf([kept, undone])).toEqual([
      [kept.id, 'Manta', 'Atlântida'],
    ]);
  });

  it('tallies the learning rows: applied, undone, carried copies counted once', () => {
    const rows = [
      row({ ruleId: 'r', transcriptId: 'x1' }),
      row({ ruleId: 'r', transcriptId: 'x2', state: 'undone' }),
      row({ ruleId: 'r', transcriptId: 'x3', kind: 'carried' }),
    ];
    expect(readLog(rows).tallies.get('r')).toEqual({ applied: 2, undone: 1 });
    expect(readLog(rows).sources).toEqual([]);
  });
});
