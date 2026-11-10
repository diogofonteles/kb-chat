import { describe, expect, it } from 'vitest';
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
