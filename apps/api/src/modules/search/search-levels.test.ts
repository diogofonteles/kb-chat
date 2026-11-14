import { describe, expect, it } from 'vitest';
import type { IndexQuery, SearchIndexPort } from '../../ports/search-index.js';
import type { TopicFolder, VaultReaderPort } from '../../ports/vault-reader.js';
import {
  OPEN_VIEW,
  scaledView,
  type LevelView,
} from '../access-levels/index.js';
import { CatalogRegistry } from '../catalog/index.js';
import { SearchService } from './search-service.js';

const docId = (n: number) => `raw/d-${String(n).padStart(4, '0')}.md`;
const SCALE = [
  {
    id: 'qs',
    code: 'QS',
    description: '',
    createdBy: 'o',
    createdAt: '2026-11-09T00:00:00.000Z',
  },
  {
    id: 'ci',
    code: 'CI',
    description: '',
    createdBy: 'o',
    createdAt: '2026-11-09T00:00:00.000Z',
  },
];

/** `count` texts, the index ranking them in id order. */
function world(count: number, hidden: (n: number) => boolean) {
  const ids = Array.from({ length: count }, (_, n) => docId(n));
  const topic: TopicFolder = { slug: 'hermetismo', title: 'Hermetismo' };
  const vault: VaultReaderPort = {
    listTopics: async () => [topic],
    listDocuments: async () => ids,
    readDocument: async (_topic, id) => `---\ntitle: ${id}\n---\n\nlua\n`,
  };
  const limits: number[] = [];
  const deep: (boolean | undefined)[] = [];
  const index: SearchIndexPort = {
    search: async (query: IndexQuery) => {
      limits.push(query.limit);
      deep.push(query.deep);
      return ids
        .slice(0, query.limit)
        .map((id, n) => ({ id, score: 1 - n / 10_000, snippet: 'lua' }));
    },
    status: () => 'ok',
    close: async () => undefined,
  };
  // The hidden ones are at CI, the rest at QS; the viewer is at QS.
  const placed = Object.fromEntries(
    ids.map((id, n) => [
      id,
      { level: hidden(n) ? 'ci' : 'qs', setBy: 'o', setAt: 'x' },
    ]),
  );
  const view = scaledView({
    scale: SCALE,
    rank: 0,
    placementsOf: () => placed,
    memo: (_catalog, compute) => compute(),
  });
  return { vault, index, limits, deep, view };
}

async function searchIn(
  count: number,
  hidden: (n: number) => boolean,
  seen?: LevelView,
) {
  const { vault, index, limits, deep, view } = world(count, hidden);
  const catalog = new CatalogRegistry(vault);
  await catalog.load();
  const service = new SearchService({ catalog, index, vault });
  const found = await service.search(
    'hermetismo',
    { q: 'lua' },
    { view: seen ?? view },
  );
  return { found, limits, deep };
}

describe('SearchService within a level (KBC-103 FR-6, ADR 0036 §7)', () => {
  it('asks the index once more, four times deeper, when the first page comes back short', async () => {
    // Half of 1 000 visible (the first call asks 60 / 0.5 × 1.5 = 180), but the top 125 are
    // hidden: 55 visible come back.
    const { found, limits } = await searchIn(1000, (n) => n < 125 || n >= 625);
    expect(limits).toEqual([180, 720]);
    expect(found.total).toBeGreaterThanOrEqual(60);
    expect(found.items.length).toBeGreaterThan(0);
    expect(found.items.every((item) => item.id >= docId(125))).toBe(true);
    expect(found.capped).toBe(true);
  });

  it('asks once when the first page is full', async () => {
    const { found, limits } = await searchIn(1000, (n) => n < 10 || n >= 510);
    expect(limits).toEqual([180]);
    expect(found.capped).toBe(true);
  });

  it('asks a deep ranking only for a partial view; whoever sees all gets the index default (KBC-120)', async () => {
    const partial = await searchIn(1000, (n) => n < 125 || n >= 625);
    expect(partial.deep).toEqual([true, true]);
    const whole = await searchIn(1000, () => false, OPEN_VIEW);
    expect(whole.limits).toEqual([60]);
    expect(whole.deep).toEqual([undefined]);
  });

  it('is not capped when the index ran out before the limit', async () => {
    const { found, limits } = await searchIn(100, (n) => n < 50);
    expect(limits).toEqual([180]);
    expect(found.total).toBe(50);
    expect(found.capped).toBe(false);
  });

  it('is not capped when even the cap found fewer visible texts than a page', async () => {
    // Only the last 40 of 1 000 visible: the 5 % floor asks the cap at once, and only once.
    const { found, limits } = await searchIn(1000, (n) => n < 960);
    expect(limits).toEqual([1000]);
    expect(found.total).toBe(40);
    expect(found.capped).toBe(false);
  });
});
