import { aHit, aResponse } from '../../testing/fixtures.js';
import {
  NO_FILTERS,
  hasFilters,
  reduceChat,
  type Ask,
  type ChatMessage,
} from './chat-message.js';

const ask: Ask = {
  id: 1,
  rev: 1,
  topic: 'hermetismo',
  question: 'ritmo',
  mode: 'all',
  filters: NO_FILTERS,
};
const start = (a: Ask = ask): readonly ChatMessage[] =>
  reduceChat([], { type: 'started', ask: a });

describe('reduceChat', () => {
  it('adds a loading message when an ask starts', () => {
    expect(start()).toEqual([
      {
        ...ask,
        status: 'loading',
        response: null,
        error: null,
        loadingMore: false,
      },
    ]);
  });

  it('stores the response and then an error on the same run', () => {
    const done = reduceChat(start(), {
      type: 'done',
      id: 1,
      rev: 1,
      response: aResponse(),
    });
    expect(done[0]?.status).toBe('done');
    const failed = reduceChat(done, {
      type: 'failed',
      id: 1,
      rev: 1,
      error: 'OFFLINE',
    });
    expect(failed[0]).toMatchObject({ status: 'error', error: 'OFFLINE' });
  });

  it('re-runs a message in place keeping its previous results while loading', () => {
    const done = reduceChat(start(), {
      type: 'done',
      id: 1,
      rev: 1,
      response: aResponse(),
    });
    const filters = { ...NO_FILTERS, genres: ['paper' as const] };
    const rerun = reduceChat(done, {
      type: 'started',
      ask: { ...ask, rev: 2, filters },
    });
    expect(rerun).toHaveLength(1);
    expect(rerun[0]).toMatchObject({ status: 'loading', rev: 2, filters });
    expect(rerun[0]?.response?.items).toHaveLength(1);
  });

  it('ignores results of a stale run', () => {
    const rerun = reduceChat(start(), {
      type: 'started',
      ask: { ...ask, rev: 2 },
    });
    const stale = reduceChat(rerun, {
      type: 'done',
      id: 1,
      rev: 1,
      response: aResponse(),
    });
    expect(stale[0]?.status).toBe('loading');
  });

  it('appends a further page and tracks the loading flag', () => {
    const first = reduceChat(start(), {
      type: 'done',
      id: 1,
      rev: 1,
      response: aResponse([aHit()], { nextOffset: 1 }),
    });
    const loading = reduceChat(first, { type: 'more-started', id: 1, rev: 1 });
    expect(loading[0]?.loadingMore).toBe(true);
    const more = reduceChat(loading, {
      type: 'more-done',
      id: 1,
      rev: 1,
      response: aResponse([aHit({ id: 'b.md' })], { nextOffset: null }),
    });
    expect(more[0]?.response?.items.map((h) => h.id)).toEqual([
      'raw/articles/a-lei-do-ritmo.md',
      'b.md',
    ]);
    expect(more[0]?.response?.nextOffset).toBeNull();
    expect(more[0]?.loadingMore).toBe(false);
    const failedMore = reduceChat(loading, {
      type: 'more-failed',
      id: 1,
      rev: 1,
    });
    expect(failedMore[0]?.loadingMore).toBe(false);
  });

  it('starts a page from scratch when the message has no response yet', () => {
    const more = reduceChat(start(), {
      type: 'more-done',
      id: 1,
      rev: 1,
      response: aResponse(),
    });
    expect(more[0]?.response?.items).toHaveLength(1);
  });
});

describe('hasFilters', () => {
  it('is true only when a facet has a value', () => {
    expect(hasFilters(NO_FILTERS)).toBe(false);
    expect(hasFilters({ ...NO_FILTERS, depths: [2] })).toBe(true);
  });
});
