import type { LibraryItem } from '@kb-chat/contracts';
import { describe, expect, it } from 'vitest';
import {
  continueListening,
  facetsOf,
  filterLibrary,
  matchesQuery,
  normalizeText,
  pageOf,
  recentlyPlayed,
  sortLibrary,
} from './library-query.js';

/** The collection's main author (KBC-049). */
const MESTRE = {
  slug: 'mestre-laercio',
  name: 'Mestre Laércio',
  main: true,
};

let next = 0;
/** A ready, unheard audio; each call a new id and a later creation time. */
function anItem(overrides: Partial<LibraryItem> = {}): LibraryItem {
  next++;
  return {
    id: `00000000-0000-4000-8000-${String(next).padStart(12, '0')}`,
    topic: 'hermetismo',
    title: `Palestra ${next}`,
    author: null,
    status: 'ready',
    progress: null,
    failure: null,
    durationMs: 60_000,
    bytes: 1,
    createdAt: new Date(Date.UTC(2026, 0, 1, 0, next)).toISOString(),
    canRetry: false,
    canEdit: false,
    positionMs: 0,
    completedAt: null,
    positionUpdatedAt: null,
    transcription: {
      status: 'none',
      confidence: null,
      version: null,
      transcriber: 'none',
      transcriberOffSince: null,
    },
    kind: 'audio',
    lastPlayedAt: null,
    ...overrides,
  };
}

const NO_FILTER = {
  states: [],
  authors: [],
  topics: null,
  query: '',
} as const;
const titles = (items: readonly LibraryItem[]) => items.map((i) => i.title);

describe('normalizeText and matchesQuery', () => {
  it('ignores case, accents and extra spaces', () => {
    expect(normalizeText('  Mestre   LAÉRCIO ')).toBe('mestre laercio');
  });

  it('needs every word, in the title or the author’s name', () => {
    const item = anItem({
      title: 'Ensino de 1998',
      author: MESTRE,
    });
    expect(matchesQuery(item, 'laercio 1998')).toBe(true);
    expect(matchesQuery(item, 'laercio 1999')).toBe(false);
    expect(matchesQuery(item, '   ')).toBe(true);
  });
});

describe('filterLibrary (BR-6)', () => {
  const playing = anItem({ title: 'Andando', positionMs: 5 });
  const fresh = anItem({ title: 'Nova', author: MESTRE });
  const freshOther = anItem({ title: 'Outra nova' });
  const heard = anItem({
    title: 'Ouvida',
    completedAt: '2026-11-01T00:00:00.000Z',
    topic: 'hermetismo/sub',
  });
  const all = [playing, fresh, freshOther, heard];

  it('adds up chips of one group and narrows across groups', () => {
    expect(
      titles(
        filterLibrary(all, {
          ...NO_FILTER,
          states: ['unheard'],
          authors: ['mestre-laercio'],
        }),
      ),
    ).toEqual(['Nova']);
    expect(
      titles(
        filterLibrary(all, { ...NO_FILTER, states: ['in-progress', 'heard'] }),
      ),
    ).toEqual(['Andando', 'Ouvida']);
  });

  it('keeps only the chosen collections', () => {
    expect(
      titles(
        filterLibrary(all, {
          ...NO_FILTER,
          topics: new Set(['hermetismo/sub']),
        }),
      ),
    ).toEqual(['Ouvida']);
  });
});

describe('sortLibrary', () => {
  const a = anItem({
    title: 'Beta',
    durationMs: 300,
    lastPlayedAt: '2026-11-02T00:00:00.000Z',
    author: null,
  });
  const b = anItem({
    title: 'alfa',
    durationMs: 100,
    lastPlayedAt: null,
    author: MESTRE,
  });
  const c = anItem({
    title: 'Ágape',
    durationMs: null,
    lastPlayedAt: '2026-11-03T00:00:00.000Z',
    author: MESTRE,
  });
  const items = [a, b, c];

  it('puts the most recently played first and never played last', () => {
    expect(titles(sortLibrary(items, 'recently-played'))).toEqual([
      'Ágape',
      'Beta',
      'alfa',
    ]);
  });

  it('orders by addition, newest first', () => {
    expect(titles(sortLibrary(items, 'recently-added'))).toEqual([
      'Ágape',
      'alfa',
      'Beta',
    ]);
  });

  it('orders titles as Portuguese readers do (case and accents aside)', () => {
    expect(titles(sortLibrary(items, 'title'))).toEqual([
      'Ágape',
      'alfa',
      'Beta',
    ]);
  });

  it('orders by length, shortest first, unknown last', () => {
    expect(titles(sortLibrary(items, 'duration'))).toEqual([
      'alfa',
      'Beta',
      'Ágape',
    ]);
  });

  it('orders by author, then title', () => {
    expect(titles(sortLibrary(items, 'author'))).toEqual([
      'Ágape',
      'alfa',
      'Beta',
    ]);
  });

  it('never changes the list it was given', () => {
    sortLibrary(items, 'title');
    expect(items).toEqual([a, b, c]);
  });
});

describe('facetsOf (SL-16)', () => {
  it('lists only the states, authors and collections that exist', () => {
    expect(
      facetsOf([
        anItem({ topic: 'alquimia', author: MESTRE }),
        anItem({
          topic: 'alquimia',
          author: { ...MESTRE, name: 'Outro nome' },
        }),
        anItem({ positionMs: 9 }),
      ]),
    ).toEqual({
      states: ['in-progress', 'unheard'],
      authors: [MESTRE],
      otherAuthors: true,
      topics: ['alquimia', 'hermetismo'],
    });
  });
});

describe('pageOf', () => {
  const items = Array.from({ length: 51 }, () => anItem());

  it('gives 50 and the cursor of the rest', () => {
    const first = pageOf(items, undefined);
    expect(first.items).toHaveLength(50);
    expect(first.nextCursor).toBe('50');
    expect(pageOf(items, '50')).toEqual({
      items: [items[50]],
      nextCursor: null,
    });
  });
});

describe('continueListening (BR-3)', () => {
  it('takes ready in-progress media, latest played first, at most 10', () => {
    const playing = Array.from({ length: 12 }, (_, n) =>
      anItem({
        title: `Andando ${n}`,
        positionMs: 1_000,
        lastPlayedAt: new Date(Date.UTC(2026, 10, 1, n)).toISOString(),
      }),
    );
    const heard = anItem({
      positionMs: 0,
      completedAt: '2026-11-03T00:00:00.000Z',
      lastPlayedAt: '2026-11-03T00:00:00.000Z',
    });
    const converting = anItem({ status: 'processing', positionMs: 10 });
    const list = continueListening([...playing, heard, converting]);
    expect(list).toHaveLength(10);
    expect(list[0]?.title).toBe('Andando 11');
    expect(list[9]?.title).toBe('Andando 2');
  });
});

describe('recentlyPlayed (BR-4)', () => {
  it('keeps only what was played after "Limpar recentes", latest first', () => {
    const before = anItem({
      title: 'Antes',
      lastPlayedAt: '2026-11-01T00:00:00.000Z',
    });
    const after = anItem({
      title: 'Depois',
      lastPlayedAt: '2026-11-02T12:00:00.000Z',
    });
    const never = anItem({ title: 'Nunca' });
    expect(
      titles(
        recentlyPlayed([before, after, never], '2026-11-02T00:00:00.000Z'),
      ),
    ).toEqual(['Depois']);
    expect(titles(recentlyPlayed([before, after, never], null))).toEqual([
      'Depois',
      'Antes',
    ]);
  });
});

describe('authors (KBC-049)', () => {
  const ana = { slug: 'ana', name: 'Ana', main: false };
  const bia = { slug: 'bia', name: 'Bia', main: false };
  const items = [
    anItem({ title: 'Sem autor', author: null }),
    anItem({ title: 'Da Bia', author: bia }),
    anItem({ title: 'Do Mestre', author: MESTRE }),
    anItem({ title: 'Da Ana', author: ana }),
  ];

  it('orders by author name, "Outros autores" last', () => {
    expect(titles(sortLibrary(items, 'author'))).toEqual([
      'Da Ana',
      'Da Bia',
      'Do Mestre',
      'Sem autor',
    ]);
  });

  it('lists the main author first, then the others by name', () => {
    expect(facetsOf(items).authors).toEqual([MESTRE, ana, bia]);
  });

  it('filters by an author or by "Outros autores" (no author)', () => {
    expect(
      titles(filterLibrary(items, { ...NO_FILTER, authors: ['bia', '-'] })),
    ).toEqual(['Sem autor', 'Da Bia']);
  });

  it('finds media by the author’s name, and "outros autores" by none', () => {
    expect(matchesQuery(items[1] as LibraryItem, 'bia')).toBe(true);
    expect(matchesQuery(items[0] as LibraryItem, 'outros autores')).toBe(true);
    expect(matchesQuery(items[3] as LibraryItem, 'outros')).toBe(false);
  });
});

describe('ties and gaps', () => {
  it('breaks equal lengths by title', () => {
    const items = [
      anItem({ title: 'Zeta', durationMs: 100 }),
      anItem({ title: 'Alfa', durationMs: 100 }),
    ];
    expect(titles(sortLibrary(items, 'duration'))).toEqual(['Alfa', 'Zeta']);
  });

  it('continues by the last save when a position was never played here, newest added on a tie', () => {
    const saved = '2026-11-01T00:00:00.000Z';
    const older = anItem({
      title: 'Antiga',
      positionMs: 5,
      positionUpdatedAt: saved,
    });
    const newer = anItem({
      title: 'Nova',
      positionMs: 5,
      positionUpdatedAt: saved,
    });
    const marked = anItem({
      title: 'Marcada antes',
      positionMs: 5,
      positionUpdatedAt: '2026-10-01T00:00:00.000Z',
    });
    expect(titles(continueListening([marked, older, newer]))).toEqual([
      'Nova',
      'Antiga',
      'Marcada antes',
    ]);
  });

  it('puts the newest added first among media played at the same time', () => {
    const at = '2026-11-02T00:00:00.000Z';
    const first = anItem({ title: 'Primeira', lastPlayedAt: at });
    const second = anItem({ title: 'Segunda', lastPlayedAt: at });
    const converting = anItem({
      title: 'Convertendo',
      status: 'processing',
      lastPlayedAt: at,
    });
    expect(titles(recentlyPlayed([first, second, converting], null))).toEqual([
      'Segunda',
      'Primeira',
    ]);
  });
});
