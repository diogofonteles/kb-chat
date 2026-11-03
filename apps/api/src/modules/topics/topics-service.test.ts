import { describe, expect, it } from 'vitest';
import { MemoryDocumentStore } from '../../adapters/memory-document-store.js';
import type { TopicFolder, VaultReaderPort } from '../../ports/vault-reader.js';
import { CatalogRegistry } from '../catalog/index.js';
import { CollectionRegistry } from './collection-registry.js';
import { CollectionsVault } from './collections-vault.js';
import { listTopics } from './topics-service.js';

class FoldersOnly implements VaultReaderPort {
  constructor(private readonly folders: readonly TopicFolder[]) {}
  async listTopics() {
    return this.folders;
  }
  async listDocuments() {
    return [];
  }
  async readDocument() {
    return null;
  }
}

async function catalogOf(folders: readonly TopicFolder[]) {
  const registry = new CollectionRegistry(new MemoryDocumentStore());
  const catalog = new CatalogRegistry(
    new CollectionsVault(new FoldersOnly(folders), registry),
  );
  await catalog.load();
  return { catalog, registry };
}

const rows = (catalog: CatalogRegistry, visible?: (slug: string) => boolean) =>
  listTopics({ catalog }, { visible }).items.map((t) => [t.slug, t.canOpen]);

describe('listTopics as a tree (KBC-048 FR-4)', () => {
  it('orders by name, each parent followed by its sub-collections', async () => {
    const { catalog } = await catalogOf([
      { slug: 'udv', title: 'UDV' },
      { slug: 'udv/zeta', title: 'Zeta', parent: 'udv' },
      { slug: 'udv/alfa', title: 'Alfa', parent: 'udv' },
      { slug: 'alquimia', title: 'Alquimia' },
      // A vault folder that only groups topics: its topic stays at the top level.
      { slug: 'harness/goclaw', title: 'Goclaw' },
    ]);
    expect(rows(catalog)).toEqual([
      ['alquimia', true],
      ['harness/goclaw', true],
      ['udv', true],
      ['udv/alfa', true],
      ['udv/zeta', true],
    ]);
  });

  it('hides a parent with no visible child and closes one shown only as a group', async () => {
    const { catalog } = await catalogOf([
      { slug: 'udv', title: 'UDV' },
      { slug: 'udv/alfa', title: 'Alfa', parent: 'udv' },
      { slug: 'outro', title: 'Outro' },
    ]);
    expect(rows(catalog, (slug) => slug === 'udv/alfa')).toEqual([
      ['udv', false],
      ['udv/alfa', true],
    ]);
  });

  it('names from the registry override the vault, and a renamed collection keeps its slug', async () => {
    const { catalog, registry } = await catalogOf([
      { slug: 'udv', title: 'UDV' },
    ]);
    await registry.rename(
      { slug: 'udv', title: 'UDV', description: '', parent: null },
      { title: 'União do Vegetal', description: 'Palestras' },
    );
    await catalog.refresh('udv');
    expect(listTopics({ catalog }).items).toEqual([
      expect.objectContaining({
        slug: 'udv',
        title: 'União do Vegetal',
        description: 'Palestras',
      }),
    ]);
  });
});
