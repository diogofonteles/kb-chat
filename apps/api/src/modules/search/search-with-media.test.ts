import type { SearchResponse } from '@kb-chat/contracts';
import { describe, expect, it, vi } from 'vitest';
import type { MediaSearchPort } from '../../ports/media-search.js';
import {
  SearchWithMedia,
  effectiveKinds,
  type MediaReport,
} from './search-with-media.js';

const DOC = {
  topic: 'udv',
  id: 'raw/historia.md',
  title: 'História da Hoasca',
  snippet: 'A Hoasca…',
  score: 0.8,
  genre: null,
  depth: null,
  relevance: null,
  concepts: [],
  authorship: 'outros-autores' as const,
  author: null,
  copies: [],
};

const texts: SearchResponse = {
  items: [DOC],
  total: 1,
  capped: false,
  nextOffset: null,
  hiddenOffTopic: 0,
  facets: {
    concepts: [],
    genres: [],
    depths: [],
    relevances: [],
    authorships: [{ value: 'outros-autores', count: 1 }],
    topics: [],
  },
  media: [],
  kinds: { text: 1, audio: null },
  mode: 'all',
  tookMs: 3,
};

const MATCH = {
  mediaId: '6f1c2b9b-8a11-4d0a-9d55-0b6f1f0e6a3e',
  topic: 'udv',
  title: 'Palestra',
  author: null,
  marked: '\u0002Hoasca\u0003',
  startMs: 1_000,
  endMs: 2_000,
  confidence: 'normal' as const,
  bm25: -2,
};

/** A media index with one passage, or one that throws on every call. */
function mediaIndex(broken = false): MediaSearchPort {
  const fail = () => {
    throw new Error('database disk image is malformed');
  };
  return {
    search: broken ? fail : () => ({ matches: [MATCH], total: 1 }),
    tally: broken ? fail : () => ({ main: 0, others: 1 }),
    hasTranscripts: () => true,
  };
}

function searcher(media: MediaSearchPort | undefined) {
  return new SearchWithMedia({
    documents: { search: async () => texts },
    scopeOf: () => ['udv'],
    media,
    authors: { mainOf: () => null, authorOf: () => null },
  });
}

const listener = { viewer: { mayHear: true, canSee: () => true } };

describe('effectiveKinds (KBC-039 BR-4)', () => {
  it('keeps the chosen kinds the collection has, and the texts when none is left', () => {
    expect(effectiveKinds(['text', 'audio'], { text: 1, audio: 2 })).toEqual([
      'text',
      'audio',
    ]);
    expect(effectiveKinds(['audio'], { text: 1, audio: 0 })).toEqual(['audio']);
    expect(effectiveKinds(['audio'], { text: 1, audio: null })).toEqual([
      'text',
    ]);
    expect(effectiveKinds(['text', 'audio'], { text: 0, audio: null })).toEqual(
      ['text'],
    );
  });
});

describe('SearchWithMedia', () => {
  it('returns the texts and the passages together', async () => {
    const found = await searcher(mediaIndex()).search(
      'udv',
      { q: 'hoasca' },
      listener,
    );
    expect(found.items).toHaveLength(1);
    expect(found.media.map((hit) => hit.text)).toEqual(['Hoasca']);
    expect(found.kinds).toEqual({ text: 1, audio: 1 });
  });

  it('falls back to the texts, and logs why, when the media index fails', async () => {
    const report = vi.fn<(entry: MediaReport) => void>();
    const found = await searcher(mediaIndex(true)).search(
      'udv',
      { q: 'hoasca', kinds: ['audio'] },
      { ...listener, report },
    );
    expect(found.items).toEqual([DOC]);
    expect(found.total).toBe(1);
    expect(found.media).toEqual([]);
    expect(found.kinds).toEqual({ text: 1, audio: null });
    expect(found.facets.authorships).toEqual(texts.facets.authorships);
    expect(report).toHaveBeenCalledWith(
      expect.objectContaining({
        mediaHits: 0,
        mediaError: expect.objectContaining({
          message: 'database disk image is malformed',
        }),
      }),
    );
  });

  it('searches the texts for a remembered "Áudios" only where there is no audio (BR-4)', async () => {
    const offLibrary = await searcher(undefined).search(
      'udv',
      { q: 'hoasca', kinds: ['audio'] },
      listener,
    );
    const notListener = await searcher(mediaIndex()).search(
      'udv',
      { q: 'hoasca', kinds: ['audio'] },
      { viewer: { mayHear: false, canSee: () => true } },
    );
    expect(offLibrary.items).toEqual([DOC]);
    expect(notListener.items).toEqual([DOC]);
    expect(notListener.media).toEqual([]);
  });
});
