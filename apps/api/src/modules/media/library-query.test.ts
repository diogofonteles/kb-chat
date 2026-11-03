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

let next = 0;
/** A ready, unheard audio; each call a new id and a later creation time. */
function anItem(overrides: Partial<LibraryItem> = {}): LibraryItem {
  next++;
  return {
    id: `00000000-0000-4000-8000-${String(next).padStart(12, '0')}`,
    topic: 'hermetismo',
    title: `Palestra ${next}`,
    authorship: 'outros-autores',
    status: 'ready',
    progress: null,
    failure: null,
    durationMs: 60_000,
    bytes: 1,
    createdAt: new Date(Date.UTC(2026, 0, 1, 0, next)).toISOString(),
    canRetry: false,
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
  kinds: [],
  states: [],
  authorships: [],
  topics: null,
  query: '',
} as const;
const titles = (items: readonly LibraryItem[]) => items.map((i) => i.title);

describe('normalizeText and matchesQuery', () => {
  it('ignores case, accents and extra spaces', () => {
    expect(normalizeText('  Mestre   LAÉRCIO ')).toBe('mestre laercio');
  });

  it('needs every word, in the title or the authorship', () => {
    const item = anItem({
      title: 'Ensino de 1998',
      authorship: 'mestre-laercio',
    });
    expect(matchesQuery(item, 'laercio 1998')).toBe(true);
    expect(matchesQuery(item, 'laercio 1999')).toBe(false);
    expect(matchesQuery(item, '   ')).toBe(true);
  });
});

describe('filterLibrary (BR-6)', () => {
  const video = anItem({
    title: 'Vídeo andando',
    kind: 'video',
    positionMs: 5,
  });
  const videoNew = anItem({ title: 'Vídeo novo', kind: 'video' });
  const audio = anItem({ title: 'Áudio andando', positionMs: 5 });
  const heard = anItem({
    title: 'Ouvida',
    completedAt: '2026-11-01T00:00:00.000Z',
    topic: 'hermetismo/sub',
  });
  const all = [video, videoNew, audio, heard];

  it('adds up chips of one group and narrows across groups', () => {
    expect(
      titles(
        filterLibrary(all, {
          ...NO_FILTER,
          kinds: ['video'],
          states: ['in-progress'],
        }),
      ),
    ).toEqual(['Vídeo andando']);
    expect(
      titles(
        filterLibrary(all, { ...NO_FILTER, states: ['in-progress', 'heard'] }),
      ),
    ).toEqual(['Vídeo andando', 'Áudio andando', 'Ouvida']);
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
    authorship: 'outros-autores',
  });
  const b = anItem({
    title: 'alfa',
    durationMs: 100,
    lastPlayedAt: null,
    authorship: 'mestre-laercio',
  });
  const c = anItem({
    title: 'Ágape',
    durationMs: null,
    lastPlayedAt: '2026-11-03T00:00:00.000Z',
    authorship: 'mestre-laercio',
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
  it('lists only the kinds, states, authorships and collections that exist', () => {
    expect(
      facetsOf([
        anItem({ kind: 'video', topic: 'alquimia' }),
        anItem({ positionMs: 9 }),
      ]),
    ).toEqual({
      kinds: ['audio', 'video'],
      states: ['in-progress', 'unheard'],
      authorships: ['outros-autores'],
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
