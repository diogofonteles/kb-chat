import type {
  SearchKind,
  SearchRequest,
  SearchResponse,
} from '@kb-chat/contracts';
import { MAX_RESULTS } from '@kb-chat/contracts';
import { describe, expect, it } from 'vitest';
import type {
  IndexHit,
  IndexQuery,
  SearchIndexPort,
} from '../../ports/search-index.js';
import type { TrackShelf } from '../../ports/track-shelf.js';
import type { TopicFolder, VaultReaderPort } from '../../ports/vault-reader.js';
import { CatalogRegistry } from '../catalog/index.js';
import { OPEN_VIEW } from '../access-levels/index.js';
import { SearchService } from './search-service.js';

const uuid = (n: number) =>
  `0b9c1f7e-1111-4a2b-8c3d-${String(n).padStart(12, '0')}`;

const textId = (n: number) => `raw/articles/t${String(n).padStart(3, '0')}.md`;
const trackId = (n: number) => `raw/media/${uuid(0)}/${uuid(n + 1)}.md`;

const textOf = (n: number) => `---\ntitle: Texto ${n}\n---\n\nritmo ${n}\n`;
const trackOf = (n: number) =>
  `---\ntitle: Faixa ${n}\nkb_chat_media_id: ${uuid(n + 1)}\nkb_chat_fingerprint: ${'a'.repeat(64)}\n---\n\n[0:00] ritmo\n`;

/** A vault of `texts` texts and `tracks` track documents in one collection. */
function vaultOf(texts: number, tracks: number): VaultReaderPort {
  const docs = new Map<string, string>();
  for (let n = 0; n < texts; n += 1) docs.set(textId(n), textOf(n));
  for (let n = 0; n < tracks; n += 1) docs.set(trackId(n), trackOf(n));
  const topic: TopicFolder = { slug: 'hermetismo', title: 'Hermetismo' };
  return {
    listTopics: async () => [topic],
    listDocuments: async () => [...docs.keys()],
    readDocument: async (_topic, id) => docs.get(id) ?? null,
  };
}

/**
 * An index that ranks every track above every text (the worst case of AC-13 at scale) and
 * answers at most `limit` hits, as QMD does.
 */
function indexOf(texts: number, tracks: number): SearchIndexPort {
  // Each document keeps its own score, whatever else the vault holds.
  const ranked: IndexHit[] = [
    ...Array.from({ length: tracks }, (_, n) => ({
      id: trackId(n),
      score: 0.9 - n / 100_000,
    })),
    ...Array.from({ length: texts }, (_, n) => ({
      id: textId(n),
      score: 0.5 - n / 10_000,
    })),
  ].map((hit) => ({ ...hit, snippet: 'ritmo' }));
  return {
    search: async (query: IndexQuery) => ranked.slice(0, query.limit),
    status: () => 'ok',
    close: async () => undefined,
  };
}

async function searchWith(
  texts: number,
  tracks: number,
  request: Partial<{ q: string; limit: number }> = {},
): Promise<SearchResponse> {
  const vault = vaultOf(texts, tracks);
  const catalog = new CatalogRegistry(vault);
  await catalog.load();
  const service = new SearchService({
    catalog,
    index: indexOf(texts, tracks),
    vault,
  });
  const found = await service.search(
    'hermetismo',
    {
      q: 'ritmo',
      mode: 'all',
      limit: 50,
      ...request,
    },
    { view: OPEN_VIEW },
  );
  return { ...found, tookMs: 0 };
}

describe('AC-13 at scale (QA F-4): track documents never change the texts search', () => {
  it.each([
    [10, 250],
    [70, 250],
    [70, 1_000],
    [300, 450],
  ])(
    'with %i texts below %i tracks, the list, total and capped equal the vault without tracks',
    async (texts, tracks) => {
      const without = await searchWith(texts, 0);
      const withTracks = await searchWith(texts, tracks);
      expect(withTracks.items.map((hit) => hit.id)).toEqual(
        without.items.map((hit) => hit.id),
      );
      expect(withTracks.total).toBe(without.total);
      expect(withTracks.capped).toBe(without.capped);
      expect(withTracks).toEqual(without);
    },
  );
});

/** A shelf that confirms every track of the vault (who has `media` and `media-tracks`). */
const everyTrack: TrackShelf = {
  trackOf: (_topic, { mediaId }) => ({
    mediaId,
    title: mediaId,
    confidence: 'normal',
  }),
  segmentsOf: () => [],
};

async function documentsWith(
  [texts, tracks]: readonly [number, number],
  request: SearchRequest = { q: 'ritmo' },
  kinds: readonly SearchKind[] = ['text', 'audio'],
) {
  const vault = vaultOf(texts, tracks);
  const catalog = new CatalogRegistry(vault);
  await catalog.load();
  const service = new SearchService({
    catalog,
    index: indexOf(texts, tracks),
    vault,
  });
  return service.searchDocuments(
    'hermetismo',
    { mode: 'all', limit: 50, ...request },
    { tracks: everyTrack, kinds, view: OPEN_VIEW },
  );
}

describe('BR-8: only a track that is a card loses its "Na fala" passage', () => {
  it('a track past the result cap keeps its spoken passage', async () => {
    const found = await documentsWith([5, MAX_RESULTS + 10]);
    const cards = found.response.items.flatMap((hit) =>
      hit.media ? [hit.media.mediaId] : [],
    );
    expect(found.response.total).toBe(MAX_RESULTS + 15);
    expect(cards).toHaveLength(MAX_RESULTS);
    expect([...found.cardTracks].sort()).toEqual([...cards].sort());
  });

  it('a card on a later page is still a card: its passage stays merged', async () => {
    const found = await documentsWith([5, 30], { q: 'ritmo', limit: 10 });
    expect(found.response.items).toHaveLength(10);
    expect(found.cardTracks).toHaveLength(30);
  });

  it('with texts alone chosen, the tracks merged are the ones "Ambos" shows (counts ignore the choice)', async () => {
    const both = await documentsWith([5, MAX_RESULTS + 10]);
    const texts = await documentsWith([5, MAX_RESULTS + 10], { q: 'ritmo' }, [
      'text',
    ]);
    expect(texts.response.items.every((hit) => !hit.media)).toBe(true);
    expect([...texts.cardTracks].sort()).toEqual([...both.cardTracks].sort());
  });
});
