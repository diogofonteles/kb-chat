import type { SearchResponse } from '@kb-chat/contracts';
import { describe, expect, it } from 'vitest';
import type {
  IndexHit,
  IndexQuery,
  SearchIndexPort,
} from '../../ports/search-index.js';
import type { TopicFolder, VaultReaderPort } from '../../ports/vault-reader.js';
import { CatalogRegistry } from '../catalog/index.js';
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
  const found = await service.search('hermetismo', {
    q: 'ritmo',
    mode: 'all',
    limit: 50,
    ...request,
  });
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
