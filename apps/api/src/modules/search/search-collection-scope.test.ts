import type { SearchRequest } from '@kb-chat/contracts';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  OPEN_SHELF,
  TRACK_IDS,
  scopeWorld,
  type ScopeWorld,
} from '../../../test/scope-vault.js';
import { OPEN_VIEW } from '../access-levels/index.js';

/**
 * A search only ever returns the chosen collection's documents and tracks and, for a parent,
 * its sub-collections' (ADR 0028): never another top-level collection's.
 */

let world: ScopeWorld;
beforeAll(async () => {
  world = await scopeWorld();
});

const scope = { view: OPEN_VIEW, tracks: OPEN_SHELF };

const searchIn = (topic: string, request: SearchRequest) =>
  world.search.search(topic, request, scope);

const placesOf = (items: readonly { topic: string; id: string }[]) =>
  items.map((hit) => `${hit.topic}:${hit.id}`).sort();

describe('SearchService keeps to the collection', () => {
  it.each(['all', 'exact', 'semantic'] as const)(
    'returns nothing on Hermetismo for words only UDV says (%s mode)',
    async (mode) => {
      const found = await searchIn('hermetismo', {
        q: 'chacrona mariri',
        mode,
      });
      expect(found.items).toEqual([]);
      expect(found.total).toBe(0);
      expect(found.trackTotal).toBe(0);
    },
  );

  it("returns Hermetismo's texts and tracks only for a word every collection says", async () => {
    const found = await searchIn('hermetismo', { q: 'ritmo' });
    expect(placesOf(found.items)).toEqual([
      'hermetismo:raw/articles/caibalion.md',
      'hermetismo:raw/articles/comum.md',
      `hermetismo:${TRACK_IDS.hermetismo}`,
    ]);
    // The same id in UDV keeps its own text out of Hermetismo's snippet.
    const comum = found.items.find((hit) => hit.id === 'raw/articles/comum.md');
    expect(comum?.title).toBe('Comum Hermetismo');
    expect(comum?.snippet).not.toContain('chacrona');
  });

  it('returns UDV with Palavra do Mestre, never Hermetismo', async () => {
    const found = await searchIn('udv', { q: 'ritmo' });
    expect(placesOf(found.items)).toEqual(
      [
        'udv:raw/articles/comum.md',
        'udv:raw/sessoes/vegetal.md',
        `udv:${TRACK_IDS.udv}`,
        'udv/palavra-do-mestre:raw/articles/palavra.md',
        `udv/palavra-do-mestre:${TRACK_IDS.palavra}`,
      ].sort(),
    );
  });

  it('keeps Palavra do Mestre to itself', async () => {
    const found = await searchIn('udv/palavra-do-mestre', { q: 'ritmo' });
    expect(new Set(found.items.map((hit) => hit.topic))).toEqual(
      new Set(['udv/palavra-do-mestre']),
    );
  });

  it('ignores a "Sub-acervo" filter naming another collection', async () => {
    for (const topics of [['udv'], ['udv/palavra-do-mestre']]) {
      const found = await searchIn('hermetismo', {
        q: 'ritmo chacrona',
        filters: { topics },
      });
      expect(found.items).toEqual([]);
    }
    const sub = await searchIn('udv', {
      q: 'ritmo',
      filters: { topics: ['hermetismo'] },
    });
    expect(sub.items).toEqual([]);
  });

  it("counts Hermetismo's facets and documents only", () => {
    const docs = world.search.documentsIn('hermetismo', scope);
    expect(new Set(docs.map((doc) => doc.topic))).toEqual(
      new Set(['hermetismo']),
    );
    const udv = world.search.documentsIn('udv', scope);
    expect(new Set(udv.map((doc) => doc.topic))).toEqual(
      new Set(['udv', 'udv/palavra-do-mestre']),
    );
  });
});
