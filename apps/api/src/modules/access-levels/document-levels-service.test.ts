import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryDocumentStore } from '../../adapters/memory-document-store.js';
import { MemoryLevelAudit } from '../../adapters/memory-level-audit.js';
import type { DocumentStorePort } from '../../ports/document-store.js';
import type { LevelAuditPort } from '../../ports/level-audit.js';
import type { StoredPerson } from '../auth/index.js';
import { CatalogRegistry } from '../catalog/index.js';
import { ContentGate } from './content-gate.js';
import { DocumentLevelsService } from './document-levels-service.js';
import { LevelDirectory } from './level-directory.js';

/**
 * DocumentLevelsService against an in-memory catalog (KBC-107 review round 1): the races and
 * edges the integration suite cannot time (QA-1 from the QA's X-11, QA-3, R1-5).
 */
const master: StoredPerson = {
  id: '0f0e0d0c-0b0a-4908-8706-050403020100',
  sub: null,
  email: 'owner@example.com',
  name: 'Owner',
  picture: null,
  role: 'master',
  topics: [],
  features: [],
  invitedBy: 'owner@example.com',
  createdAt: '2026-11-09T00:00:00.000Z',
  lastLoginAt: null,
};
const who = { actor: { by: master.email }, person: master };

/** A presence store whose writes wait for `release` while `hold` is on. */
function heldStore() {
  const inner = new MemoryDocumentStore();
  const gate: { hold: boolean; release: () => void } = {
    hold: false,
    release: () => undefined,
  };
  const store: DocumentStorePort = {
    read: () => inner.read(),
    write: async (value) => {
      if (gate.hold)
        await new Promise<void>((resolve) => (gate.release = resolve));
      await inner.write(value);
    },
  };
  return { store, gate };
}

async function world(
  options: { presence?: DocumentStorePort; audit?: LevelAuditPort } = {},
) {
  const vault = { ids: ['raw/a.md', 'raw/b.md'] };
  const catalog = new CatalogRegistry({
    listTopics: async () => [{ slug: 'hermetismo', title: 'Hermetismo' }],
    listDocuments: async () => vault.ids,
    readDocument: async (_topic, id) => `---\ntitle: Doc ${id}\n---\n`,
  });
  await catalog.load();
  const presence = new MemoryDocumentStore();
  const directory = new LevelDirectory({
    scales: new MemoryDocumentStore(),
    documents: new MemoryDocumentStore(),
    presence: options.presence ?? presence,
  });
  await directory.load();
  await directory.changeScale('hermetismo', () => ({
    next: [
      {
        id: 'qs',
        code: 'QS',
        description: '',
        createdBy: master.email,
        createdAt: '2026-11-01T00:00:00.000Z',
      },
    ],
    result: undefined,
  }));
  const audit = options.audit ?? new MemoryLevelAudit();
  const service = new DocumentLevelsService({
    directory,
    catalog,
    gate: new ContentGate({ directory, catalog }),
    audit,
    parentOf: () => null,
  });
  catalog.onReload(() => void service.reconcile());
  await service.reconcile();
  return { vault, catalog, directory, service, audit };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

const T0 = Date.parse('2026-11-11T12:00:00.000Z');

/** Fixes the clock (only `Date`: timers and promises run as usual). */
const at = (time: number) => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(time);
};

afterEach(() => {
  vi.useRealTimers();
});

/** A presence store whose writes fail while `failing` is on (a disk error). */
function switchable() {
  const inner = new MemoryDocumentStore();
  const store = {
    failing: false,
    read: () => inner.read(),
    write: (value: object) =>
      store.failing
        ? Promise.reject(new Error('disk full'))
        : inner.write(value),
  };
  return store;
}

describe('DocumentLevelsService (KBC-107 review round 1)', () => {
  it('QA-1 (X-11), BR-3: a document that arrives after the list, still without its presence mark, stays out of a bulk by filter', async () => {
    const { store, gate } = heldStore();
    const { vault, catalog, service } = await world({ presence: store });
    const listed = await service.unassigned(master, 'hermetismo', {});
    expect(listed.total).toBe(2);
    await tick();
    // A load brings c; its reconcile is stuck writing the presence file.
    gate.hold = true;
    vault.ids = [...vault.ids, 'raw/c.md'];
    await catalog.load();
    const bulk = service.bulk(who, 'hermetismo', {
      level: 'qs',
      filter: { asOf: listed.asOf },
    });
    // Another load brings d before the bulk runs.
    gate.hold = false;
    vault.ids = [...vault.ids, 'raw/d.md'];
    await catalog.load();
    gate.release();
    const result = await bulk;
    const left = await service.unassigned(master, 'hermetismo', {});
    expect(result.updated).toBe(2);
    expect(left.items.map((one) => one.id).sort()).toEqual([
      'raw/c.md',
      'raw/d.md',
    ]);
  });

  it('QA-1, R1-6: with no presence mark at all (a failed reconcile), a document is shown as arrived now, never in 1970', async () => {
    at(T0);
    const failing: DocumentStorePort = {
      read: async () => null,
      write: () => Promise.reject(new Error('disk full')),
    };
    const { vault, catalog, service } = await world({ presence: failing });
    vault.ids = [...vault.ids, 'raw/c.md'];
    await catalog.load();
    at(T0 + 1000);
    const page = await service.unassigned(master, 'hermetismo', {});
    for (const item of page.items)
      expect(item.firstSeenAt).toBe(new Date(T0 + 1000).toISOString());
    at(T0 + 5000);
    const result = await service.bulk(who, 'hermetismo', {
      level: 'qs',
      filter: { asOf: page.asOf },
    });
    expect(result.updated).toBe(0);
    // R2-1, R3-1: the confirmed rows the filter left out are said, not silently dropped.
    expect(result.skipped).toBe(3);
  });

  it.each([
    [1, ['raw/c.md']],
    [2, ['raw/c.md', 'raw/d.md']],
  ])(
    'R3-1: %i row(s) the list counted with no mark come back as skipped, the clock running between list and bulk',
    async (count, unmarked) => {
      at(T0);
      const presence = switchable();
      const { vault, catalog, service } = await world({ presence });
      presence.failing = true;
      vault.ids = [...vault.ids, ...unmarked];
      await catalog.load();
      at(T0 + 1000);
      const listed = await service.unassigned(master, 'hermetismo', {});
      expect(listed.matched).toBe(2 + count);
      at(T0 + 60_000);
      const result = await service.bulk(who, 'hermetismo', {
        level: 'qs',
        filter: { asOf: listed.asOf },
      });
      expect(result).toMatchObject({ updated: 2, skipped: count });
    },
  );

  it('R3-1: a marked arrival after the asOf is neither placed nor skipped', async () => {
    at(T0);
    const { vault, catalog, service } = await world();
    at(T0 + 1000);
    const listed = await service.unassigned(master, 'hermetismo', {});
    at(T0 + 2000);
    vault.ids = [...vault.ids, 'raw/c.md'];
    await catalog.load();
    await service.unassigned(master, 'hermetismo', {});
    at(T0 + 3000);
    const result = await service.bulk(who, 'hermetismo', {
      level: 'qs',
      filter: { asOf: listed.asOf },
    });
    expect(result).toMatchObject({ updated: 2, skipped: 0 });
    const left = await service.unassigned(master, 'hermetismo', {});
    expect(left.items.map((one) => one.id)).toEqual(['raw/c.md']);
  });

  it('QA-3: a bulk that finds nothing writes no audit line and answers updated 0', async () => {
    const audit = new MemoryLevelAudit();
    const { service } = await world({ audit });
    const listed = await service.unassigned(master, 'hermetismo', {});
    const result = await service.bulk(who, 'hermetismo', {
      level: 'qs',
      filter: { origin: 'ocr', asOf: listed.asOf },
    });
    expect(result).toMatchObject({ updated: 0, skipped: 0 });
    expect(audit.entries).toEqual([]);
  });

  it('R1-5: a document without a level keeps only its first sighting, never an old missingSince', async () => {
    const { vault, catalog, directory, service } = await world();
    await service.bulk(who, 'hermetismo', {
      level: 'qs',
      ids: [{ topic: 'hermetismo', id: 'raw/a.md' }],
    });
    vault.ids = ['raw/b.md'];
    await catalog.load();
    await service.unassigned(master, 'hermetismo', {});
    expect(directory.presenceMap()['hermetismo']?.['raw/a.md']).toHaveProperty(
      'missingSince',
    );
    // Back, and its level gone some other way: it must not carry the old clock.
    await directory.forget({ hermetismo: ['raw/a.md'] });
    vault.ids = ['raw/a.md', 'raw/b.md'];
    await catalog.load();
    await service.unassigned(master, 'hermetismo', {});
    const mark = directory.presenceMap()['hermetismo']?.['raw/a.md'];
    expect(mark).toHaveProperty('firstSeenAt');
    expect(mark).not.toHaveProperty('missingSince');
  });

  it('R2-2: when the audit fails after the levels were placed, the log keeps what was applied and the request fails', async () => {
    const failing: LevelAuditPort = {
      append: () => Promise.reject(new Error('disk full')),
      appendMany: () => Promise.reject(new Error('disk full')),
      read: () => Promise.resolve({ entries: [], next: null }),
      scaleLines: () => Promise.resolve([]),
    };
    const { service, directory } = await world({ audit: failing });
    const listed = await service.unassigned(master, 'hermetismo', {});
    const error = vi.fn();
    await expect(
      service.bulk(
        {
          ...who,
          actor: { by: master.email, actingAs: 'ana@example.com' },
          log: { error },
        },
        'hermetismo',
        {
          level: 'qs',
          filter: { asOf: listed.asOf },
        },
      ),
    ).rejects.toThrow('disk full');
    expect(directory.placementsOf('hermetismo')['raw/a.md']?.level).toBe('qs');
    expect(error).toHaveBeenCalledWith(
      expect.objectContaining({
        at: expect.any(String),
        collection: 'hermetismo',
        level: 'qs',
        by: master.email,
        actingAs: 'ana@example.com',
        documents: 2,
        filter: { asOf: listed.asOf },
        ids: [
          { topic: 'hermetismo', id: 'raw/a.md' },
          { topic: 'hermetismo', id: 'raw/b.md' },
        ],
      }),
      'document levels placed but not audited',
    );
  });

  it('R3-2: the log names the first 50 ids of a large bulk, with the total', async () => {
    const failing: LevelAuditPort = {
      append: () => Promise.reject(new Error('disk full')),
      appendMany: () => Promise.reject(new Error('disk full')),
      read: () => Promise.resolve({ entries: [], next: null }),
      scaleLines: () => Promise.resolve([]),
    };
    const { vault, catalog, service } = await world({ audit: failing });
    vault.ids = Array.from({ length: 60 }, (_, n) => `raw/doc-${n}.md`);
    await catalog.load();
    const listed = await service.unassigned(master, 'hermetismo', {});
    const error = vi.fn();
    await expect(
      service.bulk({ ...who, log: { error } }, 'hermetismo', {
        level: 'qs',
        ids:
          listed.items.length > 0
            ? vault.ids.map((id) => ({ topic: 'hermetismo', id }))
            : [],
      }),
    ).rejects.toThrow('disk full');
    const [fields] = error.mock.calls[0] ?? [];
    expect(fields).toMatchObject({ documents: 60 });
    expect(fields.ids).toHaveLength(50);
  });
});
