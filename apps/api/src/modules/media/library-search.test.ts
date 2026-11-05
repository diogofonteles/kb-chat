import {
  LIBRARY_PAGE_SIZE,
  LIBRARY_SEARCH_MAX,
  type LibraryItem,
} from '@kb-chat/contracts';
import { describe, expect, it, vi } from 'vitest';
import type { TrackLinksPort } from '../../ports/media-search.js';
import { isPublished, searchLibrary } from './library-search.js';

const anItem = (n: number, title = `Faixa ${n}`) =>
  ({
    id: `id-${n}`,
    title,
    author: null,
    status: 'ready',
    tracks: [],
  }) as unknown as LibraryItem;

type Speech = Pick<TrackLinksPort, 'spokenAmong' | 'passagesAt'>;

const speakers = (count: number, more = false): Speech => ({
  spokenAmong: () => ({
    places: Array.from({ length: count }, (_, n) => ({
      mediaId: `id-${n}`,
      place: n,
    })),
    more,
  }),
  passagesAt: (_terms, places) =>
    places.map((place) => ({
      mediaId: `id-${place}`,
      topic: 'udv',
      title: '',
      author: null,
      marked: 'dito',
      startMs: 0,
      endMs: 1,
      confidence: 'normal',
      bm25: -1,
    })),
});

const input = (
  candidates: LibraryItem[],
  speech?: Speech,
  cursor?: string,
) => ({
  candidates,
  entries: candidates,
  subjects: null,
  query: { q: 'dito', ...(cursor ? { cursor } : {}) },
  speech,
  tracks: true,
});

describe('searchLibrary (KBC-096)', () => {
  it('R6: stops at the cap and says more exist', () => {
    const many = Array.from({ length: LIBRARY_SEARCH_MAX + 5 }, (_, n) =>
      anItem(n, `dito ${n}`),
    );
    const page = searchLibrary(input(many));
    expect(page).toMatchObject({ total: LIBRARY_SEARCH_MAX, capped: true });
    expect(page.items).toHaveLength(LIBRARY_PAGE_SIZE);
  });

  it('R6: says so when the speech alone passes the cap', () => {
    const many = Array.from({ length: LIBRARY_SEARCH_MAX }, (_, n) =>
      anItem(n),
    );
    const page = searchLibrary(input(many, speakers(LIBRARY_SEARCH_MAX, true)));
    expect(page).toMatchObject({ total: LIBRARY_SEARCH_MAX, capped: true });
  });

  it('reads the passages of the page on screen only', () => {
    const many = Array.from({ length: 60 }, (_, n) => anItem(n));
    const speech = speakers(60);
    const read = vi.spyOn(speech, 'passagesAt');
    const page = searchLibrary(input(many, speech, '50'));
    expect(page.items).toHaveLength(10);
    expect(read.mock.calls[0]?.[1]).toHaveLength(10);
    expect(page.items[0]?.passage?.text).toBe('dito');
  });

  it('R4: an archived or unfinished media is no result', () => {
    expect(isPublished(anItem(1))).toBe(true);
    expect(isPublished({ ...anItem(1), archived: true })).toBe(false);
    expect(isPublished({ ...anItem(1), status: 'queued' })).toBe(false);
  });

  it('R4: without the speech port no transcript is asked', () => {
    const page = searchLibrary(input([anItem(1)]));
    expect(page.items).toEqual([]);
  });
});
