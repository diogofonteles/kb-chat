import { describe, expect, it } from 'vitest';
import { MemoryDocumentStore } from '../../adapters/memory-document-store.js';
import type { TopicFolder, VaultReaderPort } from '../../ports/vault-reader.js';
import { CatalogRegistry } from '../catalog/index.js';
import { AuthorDirectory } from './author-directory.js';
import { AuthorsService } from './authors-service.js';
import { seedLegacyAuthors } from './legacy-seed.js';

interface FakeTopic {
  readonly folder: TopicFolder;
  /** The `author_group` of each document. */
  readonly groups: readonly string[];
}

const topic = (
  slug: string,
  parent?: string,
  groups: string[] = [],
): FakeTopic => ({
  folder: { slug, title: slug, ...(parent && { parent }) },
  groups,
});

/** Topics whose documents carry only an `author_group` (the kb's frontmatter). */
class GroupsVault implements VaultReaderPort {
  constructor(private readonly topics: readonly FakeTopic[]) {}
  async listTopics() {
    return this.topics.map((one) => one.folder);
  }
  async listDocuments(slug: string) {
    const groups = this.topics.find((one) => one.folder.slug === slug)?.groups;
    return (groups ?? []).map((_, i) => `raw/d${i}.md`);
  }
  async readDocument(slug: string, id: string) {
    const groups = this.topics.find((one) => one.folder.slug === slug)?.groups;
    const group = groups?.[Number(/\d+/.exec(id)?.[0])];
    return group
      ? `---\ntitle: D\nauthor_group: ${group}\n---\nTexto.\n`
      : null;
  }
}

async function service(topics: FakeTopic[], store = new MemoryDocumentStore()) {
  const directory = new AuthorDirectory(store);
  await directory.load();
  const catalog = new CatalogRegistry(new GroupsVault(topics));
  await catalog.load();
  return {
    directory,
    catalog,
    store,
    authors: new AuthorsService({
      directory,
      catalog,
      now: () => new Date('2026-11-03T12:00:00.000Z'),
    }),
  };
}

const UDV = [topic('udv'), topic('udv/palavra-do-mestre', 'udv')];

describe('AuthorsService (KBC-049)', () => {
  it('registers a name once: the same name, accents or case aside, is the same author', async () => {
    const { authors } = await service(UDV);

    const first = await authors.add('udv', { name: 'Mestre Gabriel' }, 'a@x');
    const again = await authors.add('udv', { name: 'mestre gabriel' }, 'b@x');

    expect(first).toEqual({
      author: { slug: 'mestre-gabriel', name: 'Mestre Gabriel', main: false },
      created: true,
    });
    expect(again).toEqual({ ...first, created: false });
    expect(authors.list('udv')).toHaveLength(1);
  });

  it("gives a sub-collection its parent's list and main author (BR-1, AC-3)", async () => {
    const { authors } = await service(UDV);
    await authors.add(
      'udv/palavra-do-mestre',
      { name: 'Mestre Gabriel' },
      'a@x',
    );
    await authors.setMain('udv', 'mestre-gabriel');

    expect(authors.list('udv/palavra-do-mestre')).toEqual(authors.list('udv'));
    expect(authors.mainOf('udv/palavra-do-mestre')).toEqual({
      slug: 'mestre-gabriel',
      name: 'Mestre Gabriel',
    });
    await expect(
      authors.setMain('udv/palavra-do-mestre', null),
    ).rejects.toThrow("A sub-collection uses its parent's main author");
  });

  it('lists the main author first, then by name, and refuses a main author it does not have', async () => {
    const { authors } = await service(UDV);
    for (const name of ['Zé', 'Ana', 'Mestre Gabriel'])
      await authors.add('udv', { name }, 'a@x');
    await authors.setMain('udv', 'mestre-gabriel');

    expect(authors.list('udv').map((one) => one.name)).toEqual([
      'Mestre Gabriel',
      'Ana',
      'Zé',
    ]);
    await expect(authors.setMain('udv', 'ninguem')).rejects.toThrow(
      'Unknown author',
    );
  });

  it('refuses a name with no letter', async () => {
    const { authors } = await service(UDV);
    await expect(authors.add('udv', { name: '!!!' }, 'a@x')).rejects.toThrow(
      'The name needs a letter',
    );
  });

  it('keeps the authors in the file and reads them back after a restart', async () => {
    const { authors, store } = await service(UDV);
    await authors.add('udv', { name: 'Mestre Gabriel' }, 'a@x');

    const restarted = await service(UDV, store);
    expect(restarted.authors.list('udv')).toEqual([
      { slug: 'mestre-gabriel', name: 'Mestre Gabriel', main: false },
    ]);
  });
});

describe('concurrent writes (KBC-049 review)', () => {
  it('keeps both of two authors registered at once, and a main author set meanwhile', async () => {
    const { authors, store } = await service(UDV);
    await authors.add('udv', { name: 'Ana' }, 'a@x');

    await Promise.all([
      authors.add('udv', { name: 'Bia' }, 'a@x'),
      authors.add('udv', { name: 'Caio' }, 'b@x'),
      authors.setMain('udv', 'ana'),
    ]);

    const reread = await service(UDV, store);
    expect(reread.authors.list('udv').map((one) => one.name)).toEqual([
      'Ana',
      'Bia',
      'Caio',
    ]);
    expect(reread.authors.mainOf('udv')?.slug).toBe('ana');
  });
});

describe('the legacy seed (KBC-049 BR-4, AC-5)', () => {
  const vault = [
    topic('hermetismo', undefined, ['mestre-laercio', 'outros-autores']),
    topic('alquimia', undefined, ['outros-autores']),
    ...UDV,
  ];

  it('makes Mestre Laércio the main author where his documents or media are', async () => {
    const { authors, directory, catalog } = await service(vault);

    const seeded = await seedLegacyAuthors({
      directory,
      authors,
      catalog,
      mediaTopicsOfLegacyAuthor: () => ['udv/palavra-do-mestre'],
    });

    expect(seeded).toEqual(['hermetismo', 'udv']);
    expect(authors.mainVoiceOf('hermetismo')).toEqual({
      name: 'Mestre Laércio',
      fullName: 'José Laércio do Egito',
      aliases: ['o Mestre', 'Laércio'],
    });
    expect(authors.mainOf('hermetismo')).toEqual({
      slug: 'mestre-laercio',
      name: 'Mestre Laércio',
    });
    expect(authors.mainOf('alquimia')).toBeNull();
  });

  it('never overrides a collection already in the file (a cleared main author stays cleared)', async () => {
    const { authors, directory, catalog } = await service(vault);
    await seedLegacyAuthors({ directory, authors, catalog });
    await authors.setMain('hermetismo', null);

    expect(await seedLegacyAuthors({ directory, authors, catalog })).toEqual(
      [],
    );
    expect(authors.mainOf('hermetismo')).toBeNull();
    expect(authors.list('hermetismo')).toHaveLength(1);
  });
});

describe('the authors file', () => {
  it('refuses a corrupt file instead of guessing', async () => {
    const store = new MemoryDocumentStore();
    await store.write({
      version: 1,
      collections: { udv: { main: 'nobody', authors: [] } },
    });
    await expect(new AuthorDirectory(store).load()).rejects.toThrow(
      'authors.json is invalid',
    );
  });

  it('keeps 500 authors and lists them fast (NFR-1)', async () => {
    const { authors } = await service(UDV);
    for (let i = 0; i < 500; i += 1)
      await authors.add('udv', { name: `Autor ${i}` }, 'a@x');

    const started = performance.now();
    const listed = authors.list('udv/palavra-do-mestre');
    expect(listed).toHaveLength(500);
    expect(performance.now() - started).toBeLessThan(100);
  });
});
