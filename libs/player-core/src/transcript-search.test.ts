import { describe, expect, it } from 'vitest';
import { foldForSearch, searchSegments } from './transcript-search.js';

describe('foldForSearch', () => {
  it('drops accents and case, keeping where each character came from', () => {
    const { folded, offsets } = foldForSearch('Ação É');
    expect(folded).toBe('acao e');
    expect(offsets).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });

  it('maps characters outside the basic plane and decomposed text', () => {
    const decomposed = 'Salomão'.normalize('NFD');
    expect(foldForSearch(decomposed).folded).toBe('salomao');
    const emoji = foldForSearch('😀a');
    expect(emoji.folded).toBe('😀a');
    expect(emoji.offsets).toEqual([0, 0, 2, 3]);
  });
});

describe('searchSegments (KBC-038 FR-8, AC-9)', () => {
  const texts = [
    'O rei Salomão falou.',
    'Nada aqui.',
    'SALOMÃO e salomao, de novo Salomão.',
  ];

  it('finds "salomao" in every form, in reading order, with original places', () => {
    const hits = searchSegments(texts, 'salomao');
    expect(hits).toEqual([
      { segment: 0, start: 6, end: 13 },
      { segment: 2, start: 0, end: 7 },
      { segment: 2, start: 10, end: 17 },
      { segment: 2, start: 27, end: 34 },
    ]);
    const third = texts[2] ?? '';
    expect(
      hits.map((hit) => texts[hit.segment]?.slice(hit.start, hit.end)),
    ).toEqual(['Salomão', 'SALOMÃO', 'salomao', third.slice(27, 34)]);
  });

  it('ignores extra spaces in the query and finds nothing for a blank one', () => {
    expect(searchSegments(texts, '  rei   salomão ')).toEqual([
      { segment: 0, start: 2, end: 13 },
    ]);
    expect(searchSegments(texts, '   ')).toEqual([]);
    expect(searchSegments(texts, 'xyz')).toEqual([]);
  });

  it('counts back-to-back occurrences without overlapping them', () => {
    expect(searchSegments(['aaaa'], 'aa')).toEqual([
      { segment: 0, start: 0, end: 2 },
      { segment: 0, start: 2, end: 4 },
    ]);
  });
});
