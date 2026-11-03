import { describe, expect, it } from 'vitest';
import { MemoryDocumentStore } from '../../adapters/memory-document-store.js';
import type { TopicFolder, VaultReaderPort } from '../../ports/vault-reader.js';
import { CatalogRegistry } from '../catalog/index.js';
import { CollectionRegistry } from './collection-registry.js';
import { CollectionsVault } from './collections-vault.js';
import {
  canSeeTopic,
  type ParentOf,
  type StoredPerson,
} from '../auth/index.js';
import { TopicsService, listTopics } from './topics-service.js';

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

describe('TopicsService.create (KBC-048 NFR-2)', () => {
  it('undoes the collection when its creator cannot be given access', async () => {
    const { catalog, registry } = await catalogOf([]);
    const service = new TopicsService({
      catalog,
      registry,
      grant: () => Promise.reject(new Error('people.json is busy')),
    });
    const actor = {
      personId: 'p1',
      personEmail: 'ana@example.com',
      email: 'ana@example.com',
      isMaster: false,
      canSee: () => true,
    };
    await expect(service.create(actor, { title: 'Novo' })).rejects.toThrow(
      'people.json is busy',
    );
    expect(await registry.list()).toEqual([]);
    expect(catalog.get('novo')).toBeUndefined();
  });
});

describe('canSeeTopic by the real tree (KBC-048 BR-3)', () => {
  const ana = {
    role: 'member',
    topics: ['harness', 'udv'],
  } as unknown as StoredPerson;
  const tree: ParentOf = (slug) =>
    slug === 'udv/palavra-do-mestre' ? 'udv' : null;

  it('reaches a sub-collection through its parent in the tree', () => {
    expect(canSeeTopic(ana, 'udv/palavra-do-mestre', tree)).toBe(true);
  });

  it('never through the slug text: a grouping folder or no tree grants nothing', () => {
    expect(canSeeTopic(ana, 'harness/goclaw', tree)).toBe(false);
    expect(canSeeTopic(ana, 'udv/palavra-do-mestre')).toBe(false);
  });
});
