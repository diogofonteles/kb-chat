import { describe, expect, it, vi } from 'vitest';
import { MemoryDocumentStore } from '../../adapters/memory-document-store.js';
import { MemoryLevelAudit } from '../../adapters/memory-level-audit.js';
import { CatalogRegistry } from '../catalog/index.js';
import { AccessLevelsService } from './access-levels-service.js';
import { ContentGate } from './content-gate.js';
import { LevelDirectory } from './level-directory.js';

/** `udv/palavra` without `udv` in the catalog: an orphan sub-collection. */
async function orphanWorld() {
  const directory = new LevelDirectory({
    scales: new MemoryDocumentStore(),
    documents: new MemoryDocumentStore(),
    presence: new MemoryDocumentStore(),
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
  const service = new AccessLevelsService({
    directory,
    catalog,
    gate,
    people: { list: async () => [], placeLevels: async () => 0 },
    audit: new MemoryLevelAudit(),
    parentOf: (slug) => catalog.get(slug)?.topic.parent ?? null,
  });
  return { service, directory };
}

describe('AccessLevelsService (KBC-103 review round 2)', () => {
  it('refuses a scale on an orphan sub-collection: it would be inert once its parent is back', async () => {
    const { service, directory } = await orphanWorld();
    await expect(
      service.create({ by: 'owner@example.com' }, 'udv/palavra', {
        code: 'QS',
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(directory.scaleOf('udv/palavra')).toEqual([]);
  });
});

describe("AccessLevelsService: the start's media seed (KBC-105 AC-10, review round 2)", () => {
  async function seededWorld(seeded: () => number | null) {
    const directory = new LevelDirectory({
      scales: new MemoryDocumentStore(),
      documents: new MemoryDocumentStore(),
      presence: new MemoryDocumentStore(),
    });
    await directory.load();
    const catalog = new CatalogRegistry({
      listTopics: async () => [{ slug: 'hermetismo', title: 'Hermetismo' }],
      listDocuments: async () => [],
      readDocument: async () => '---\ntitle: A\n---\n',
    });
    await catalog.load();
    await directory.changeScale('hermetismo', () => ({
      next: [
        {
          id: 'qs',
          code: 'QS',
          description: '',
          createdBy: 'owner@example.com',
          createdAt: '2026-11-01T00:00:00.000Z',
        },
      ],
      result: undefined,
    }));
    const service = new AccessLevelsService({
      directory,
      catalog,
      gate: new ContentGate({ directory, catalog }),
      people: { list: async () => [], placeLevels: async () => 0 },
      audit: {
        append: () => Promise.reject(new Error('disk full')),
        appendMany: () => Promise.reject(new Error('disk full')),
        read: () => Promise.resolve({ entries: [], next: null }),
        scaleLines: () => Promise.resolve([]),
      },
      media: { seedLevel: seeded, countLevels: () => ({}) },
      parentOf: () => null,
    });
    return service;
  }

  it('logs what was placed when the record fails, and fails that start', async () => {
    const service = await seededWorld(() => 3);
    const log = { error: vi.fn() };

    await expect(service.seedMediaAtStart(log)).rejects.toThrow('disk full');

    expect(log.error).toHaveBeenCalledWith(
      expect.objectContaining({
        collection: 'hermetismo',
        level: 'qs',
        media: 3,
      }),
      'media levels seeded but not audited',
    );
  });

  it('goes on at the next start, the seed already marked: the log line is the only trace', async () => {
    const service = await seededWorld(() => null);
    const log = { error: vi.fn() };

    await expect(service.seedMediaAtStart(log)).resolves.toBeUndefined();

    expect(log.error).not.toHaveBeenCalled();
  });
});
