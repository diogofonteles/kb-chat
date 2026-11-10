import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { MemoryDocumentStore } from '../../adapters/memory-document-store.js';
import type { StoredPerson } from '../auth/index.js';
import {
  CatalogRegistry,
  RelationIndex,
  toCatalogEntry,
  type TopicCatalog,
} from '../catalog/index.js';
import { ContentGate } from './content-gate.js';
import { LevelDirectory, type StoredLevel } from './level-directory.js';
import {
  CLOSED_VIEW,
  MIN_VISIBLE_SHARE,
  OPEN_VIEW,
  allowsInScope,
  scaledView,
} from './level-view.js';

const level = (id: string): StoredLevel => ({
  id,
  code: id.toUpperCase(),
  description: '',
  createdBy: 'owner@example.com',
  createdAt: '2026-11-09T00:00:00.000Z',
});
const SCALE = [level('qs'), level('ci'), level('cdc')];
const entry = (id: string) => toCatalogEntry(id, { title: id });
const track = (id: string) =>
  toCatalogEntry(id, {
    title: id,
    kb_chat_media_id: '0f0e0d0c-0b0a-4908-8706-050403020100',
    kb_chat_fingerprint: 'f',
  });
const placed = (levels: Record<string, string>) =>
  Object.fromEntries(
    Object.entries(levels).map(([id, one]) => [
      id,
      { level: one, setBy: 'o', setAt: '2026-11-09T00:00:00.000Z' },
    ]),
  );

const catalogOf = (ids: readonly string[]): TopicCatalog => {
  const entries = new Map(ids.map((id) => [id, entry(id)]));
  return {
    topic: { slug: 'hermetismo', title: 'Hermetismo' },
    entries,
    relations: new RelationIndex(entries.values()),
  };
};

const viewAt = (rank: number | 'all', levels: Record<string, string>) =>
  scaledView({
    scale: SCALE,
    rank,
    placementsOf: () => placed(levels),
    memo: (_catalog, compute) => compute(),
  });

describe('The level rule (KBC-103 BR-3, BR-6, ADR 0036 §6)', () => {
  it('sees its own level and every level below, nothing above', () => {
    const view = viewAt(1, { a: 'qs', b: 'ci', c: 'cdc' });
    expect(view.allows('hermetismo', entry('a'))).toBe(true);
    expect(view.allows('hermetismo', entry('b'))).toBe(true);
    expect(view.allows('hermetismo', entry('c'))).toBe(false);
    expect(view.allowedLevelIds()).toEqual(['qs', 'ci']);
    expect(view.levelOf('hermetismo', 'a')).toBeUndefined();
  });

  it('keeps a document without a level, or with a deleted one, for masters only', () => {
    const member = viewAt(2, { gone: 'old' });
    expect(member.allows('hermetismo', entry('none'))).toBe(false);
    expect(member.allows('hermetismo', entry('gone'))).toBe(false);
    const master = viewAt('all', { b: 'ci' });
    expect(master.allows('hermetismo', entry('none'))).toBe(true);
    expect(master.levelOf('hermetismo', 'none')).toBeNull();
    expect(master.levelOf('hermetismo', 'b')).toEqual({ id: 'ci', code: 'CI' });
    expect(master.allowedLevelIds()).toBeNull();
    expect(master.visibleShare(catalogOf(['a']))).toBe(1);
  });

  it('keeps track documents closed to members until KBC-106', () => {
    expect(viewAt(2, {}).allows('hermetismo', track('t'))).toBe(false);
    expect(viewAt('all', {}).allows('hermetismo', track('t'))).toBe(true);
  });

  it('counts the visible share of the texts, never under 5 %', () => {
    const catalog = catalogOf(['a', 'b', 'c', 'd']);
    expect(viewAt(0, { a: 'qs', b: 'ci' }).visibleShare(catalog)).toBe(0.25);
    expect(viewAt(0, {}).visibleShare(catalog)).toBe(MIN_VISIBLE_SHARE);
    expect(viewAt(0, {}).visibleShare(catalogOf([]))).toBe(1);
    expect(OPEN_VIEW.allows('x', entry('a'))).toBe(true);
  });

  it('never lets a viewer see an item above their rank (property)', () => {
    fc.assert(
      fc.property(
        fc.dictionary(
          fc.string({ minLength: 1, maxLength: 6 }),
          fc.constantFrom('qs', 'ci', 'cdc', 'gone'),
        ),
        fc.integer({ min: 0, max: 2 }),
        (levels, rank) => {
          const view = viewAt(rank, levels);
          for (const [id, held] of Object.entries(levels)) {
            const itemRank = SCALE.findIndex((one) => one.id === held);
            const seen = view.allows('hermetismo', entry(id));
            expect(seen).toBe(itemRank >= 0 && itemRank <= rank);
          }
        },
      ),
    );
  });
});

const person = (over: Partial<StoredPerson> = {}): StoredPerson => ({
  id: '0f0e0d0c-0b0a-4908-8706-050403020100',
  sub: null,
  email: 'ana@example.com',
  name: 'Ana',
  picture: null,
  role: 'member',
  topics: ['hermetismo'],
  features: ['search'],
  invitedBy: 'owner@example.com',
  createdAt: '2026-11-09T00:00:00.000Z',
  lastLoginAt: null,
  ...over,
});

/** A catalog of `count` texts in `hermetismo`, read from a vault in memory. */
async function bigCatalog(count: number): Promise<CatalogRegistry> {
  const ids = Array.from({ length: count }, (_, n) => `raw/d-${n}.md`);
  const registry = new CatalogRegistry({
    listTopics: async () => [{ slug: 'hermetismo', title: 'Hermetismo' }],
    listDocuments: async () => ids,
    readDocument: async (_topic, id) => `---\ntitle: ${id}\n---\n`,
  });
  await registry.load();
  return registry;
}

async function gateOver(count: number) {
  const directory = new LevelDirectory({
    scales: new MemoryDocumentStore(),
    documents: new MemoryDocumentStore(),
  });
  await directory.load();
  await directory.changeScale('hermetismo', () => ({
    next: SCALE,
    result: undefined,
  }));
  const levels: Record<string, string> = {};
  for (let n = 0; n < count; n += 1)
    levels[`raw/d-${n}.md`] = SCALE[n % 3]?.id ?? 'qs';
  await directory.place({ hermetismo: placed(levels) });
  const catalog = await bigCatalog(count);
  return { gate: new ContentGate({ directory, catalog }), catalog, directory };
}

describe('The visible entries of a scope (ADR 0036 §7, KBC-104 FR-3)', () => {
  const byCollection: Record<string, Record<string, string>> = {
    hermetismo: { 'raw/a.md': 'qs', 'raw/b.md': 'cdc' },
    'hermetismo/aulas': { 'raw/a.md': 'cdc', 'raw/c.md': 'ci' },
  };
  const view = scaledView({
    scale: SCALE,
    rank: 1,
    placementsOf: (collection) => placed(byCollection[collection] ?? {}),
    memo: (_catalog, compute) => compute(),
  });
  // A parent's scope: its own ids, and a sub-collection's by its home.
  const scope = {
    topic: 'hermetismo',
    entries: new Map([
      ['raw/a.md', entry('raw/a.md')],
      ['raw/b.md', entry('raw/b.md')],
      [
        'aulas/raw/a.md',
        {
          ...entry('aulas/raw/a.md'),
          home: { topic: 'hermetismo/aulas', id: 'raw/a.md' },
        },
      ],
      [
        'aulas/raw/c.md',
        {
          ...entry('aulas/raw/c.md'),
          home: { topic: 'hermetismo/aulas', id: 'raw/c.md' },
        },
      ],
    ]),
  };

  it('judges each document in its own collection, a sub-collection one by its home', () => {
    expect(view.entries(scope).map((one) => one.id)).toEqual([
      'raw/a.md',
      'aulas/raw/c.md',
    ]);
    const hidden = {
      id: 'aulas/raw/a.md',
      media: null,
      home: { topic: 'hermetismo/aulas', id: 'raw/a.md' },
    };
    expect(allowsInScope(view, 'hermetismo', hidden)).toBe(false);
    // The same id in the parent itself is at QS: seen.
    expect(allowsInScope(view, 'hermetismo', entry('raw/a.md'))).toBe(true);
  });

  it('gives the whole scope to the open view and nothing to the closed one', () => {
    expect(OPEN_VIEW.entries(scope)).toHaveLength(4);
    expect(CLOSED_VIEW.entries(scope)).toEqual([]);
  });
});

describe('The content gate (KBC-103 BR-5, NFR-1)', () => {
  it('gives a person without a level, or with an unknown one, the lowest', async () => {
    const { gate } = await gateOver(3);
    expect(gate.personRank(person(), 'hermetismo')).toBe(0);
    expect(
      gate.personRank(person({ levels: { hermetismo: 'gone' } }), 'hermetismo'),
    ).toBe(0);
    expect(
      gate.personRank(person({ levels: { hermetismo: 'cdc' } }), 'hermetismo'),
    ).toBe(2);
    expect(gate.viewFor(person({ role: 'master' }), 'hermetismo').seesAll).toBe(
      true,
    );
    expect(gate.viewFor(person(), 'alquimia')).toBe(OPEN_VIEW);
    expect(gate.tracksClosedByLevels(person(), 'hermetismo')).toBe(true);
    expect(
      gate.tracksClosedByLevels(person({ role: 'master' }), 'hermetismo'),
    ).toBe(false);
  });

  it('NFR-1: builds a view of 10,000 documents and its share in p95 ≤ 5 ms', async () => {
    const { gate, catalog } = await gateOver(10_000);
    const hermetismo = catalog.get('hermetismo');
    if (!hermetismo) throw new Error('no catalog');
    const times: number[] = [];
    for (let run = 0; run < 40; run += 1) {
      const startedAt = performance.now();
      const view = gate.viewFor(
        person({ levels: { hermetismo: 'ci' } }),
        'hermetismo',
      );
      expect(view.visibleShare(hermetismo)).toBeCloseTo(2 / 3, 2);
      times.push(performance.now() - startedAt);
    }
    times.sort((a, b) => a - b);
    const p95 = times[Math.ceil(times.length * 0.95) - 1] ?? Infinity;
    expect(p95).toBeLessThanOrEqual(5);
  });

  it('an orphan sub-collection (its parent not in the catalog) gets the CLOSED_VIEW for members only', async () => {
    const directory = new LevelDirectory({
      scales: new MemoryDocumentStore(),
      documents: new MemoryDocumentStore(),
    });
    await directory.load();
    const catalog = new CatalogRegistry({
      listTopics: async () => [
        { slug: 'udv/palavra', title: 'Palavra', parent: 'udv' },
      ],
      listDocuments: async () => ['raw/a.md'],
      readDocument: async () => '---\ntitle: A\n---\n',
    });
    await catalog.load();
    const gate = new ContentGate({ directory, catalog });
    const member = gate.viewFor(
      person({ topics: ['udv/palavra'] }),
      'udv/palavra',
    );
    expect(member).toBe(CLOSED_VIEW);
    expect(member.allows('udv/palavra', entry('raw/a.md'))).toBe(false);
    expect(gate.tracksClosedByLevels(person(), 'udv/palavra')).toBe(true);
    const master = gate.viewFor(person({ role: 'master' }), 'udv/palavra');
    expect(master.allows('udv/palavra', entry('raw/a.md'))).toBe(true);
  });

  it('keeps the memoized shares of the current state only', async () => {
    const { gate, catalog, directory } = await gateOver(30);
    const hermetismo = catalog.get('hermetismo');
    if (!hermetismo) throw new Error('no catalog');
    const ana = person({ levels: { hermetismo: 'ci' } });
    expect(
      gate.viewFor(ana, 'hermetismo').visibleShare(hermetismo),
    ).toBeCloseTo(2 / 3);
    expect(gate.memoSize(hermetismo)).toBe(1);
    expect(
      gate.viewFor(person(), 'hermetismo').visibleShare(hermetismo),
    ).toBeCloseTo(1 / 3);
    expect(gate.memoSize(hermetismo)).toBe(2);
    // A level write is a new state: the shares of the old one go.
    await directory.place({ hermetismo: placed({ 'raw/d-0.md': 'cdc' }) });
    gate.viewFor(ana, 'hermetismo').visibleShare(hermetismo);
    expect(gate.memoSize(hermetismo)).toBe(1);
  });
});
