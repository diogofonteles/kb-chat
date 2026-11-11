import { describe, expect, it, vi } from 'vitest';
import { MemoryDocumentStore } from '../../adapters/memory-document-store.js';
import { MemoryLevelAudit } from '../../adapters/memory-level-audit.js';
import type { StoredPerson } from '../auth/index.js';
import { CatalogRegistry } from '../catalog/index.js';
import { ContentGate } from './content-gate.js';
import { LevelDirectory } from './level-directory.js';
import { PeopleLevelsService } from './people-levels-service.js';

const AT = '2026-11-01T00:00:00.000Z';
const level = (id: string) => ({
  id,
  code: id.toUpperCase(),
  description: '',
  createdBy: 'owner@example.com',
  createdAt: AT,
});

const person = (id: string, topics: string[]): StoredPerson => ({
  id,
  sub: null,
  email: `${id}@example.com`,
  name: '',
  picture: null,
  role: 'member',
  topics,
  features: ['search'],
  invitedBy: 'owner@example.com',
  createdAt: AT,
  lastLoginAt: null,
});

/** Hermetismo (QS < CI) with the sub-collection Aulas, and Alquimia without a scale. */
async function world(audit = new MemoryLevelAudit()) {
  const directory = new LevelDirectory({
    scales: new MemoryDocumentStore(),
    documents: new MemoryDocumentStore(),
    presence: new MemoryDocumentStore(),
  });
  await directory.load();
  const catalog = new CatalogRegistry({
    listTopics: async () => [
      { slug: 'hermetismo', title: 'Hermetismo' },
      { slug: 'hermetismo/aulas', title: 'Aulas', parent: 'hermetismo' },
      { slug: 'alquimia', title: 'Alquimia' },
    ],
    listDocuments: async () => [],
    readDocument: async () => '---\ntitle: A\n---\n',
  });
  await catalog.load();
  await directory.changeScale('hermetismo', () => ({
    next: [level('qs'), level('ci')],
    result: undefined,
  }));
  const people = [person('ana', ['hermetismo/aulas'])];
  const service = new PeopleLevelsService({
    directory,
    catalog,
    gate: new ContentGate({ directory, catalog }),
    audit,
    parentOf: (slug) => catalog.get(slug)?.topic.parent ?? null,
    people: {
      setLevels: async ({ root, level: to, keeps }) =>
        people.filter(keeps).map((one) => ({
          person: { ...one, levels: { [root]: to } },
          before: null,
        })),
    },
  });
  return { service };
}

describe('PeopleLevelsService.resolve (KBC-109 BR-2, BR-3)', () => {
  it('gives the lowest level through a sub-collection, keeps a valid held one, takes a named one', async () => {
    const { service } = await world();
    const grant = { role: 'member' as const, topics: ['hermetismo/aulas'] };
    expect(service.resolve(grant)).toEqual({ hermetismo: 'qs' });
    expect(service.resolve({ ...grant, held: { hermetismo: 'ci' } })).toEqual(
      {},
    );
    expect(
      service.resolve({
        ...grant,
        levels: { hermetismo: 'qs' },
        held: { hermetismo: 'ci' },
      }),
    ).toEqual({ hermetismo: 'qs' });
    expect(
      service.resolve({ ...grant, levels: { hermetismo: 'gone' } }),
    ).toEqual({ hermetismo: 'qs' });
    expect(service.resolve({ ...grant, held: { hermetismo: 'gone' } })).toEqual(
      { hermetismo: 'qs' },
    );
    expect(service.resolve({ role: 'master', topics: ['hermetismo'] })).toEqual(
      {},
    );
    expect(service.resolve({ role: 'member', topics: ['alquimia'] })).toEqual(
      {},
    );
  });

  it('marks as stale only a level its scale no longer has', async () => {
    const { service } = await world();
    expect(
      service.staleLevels({
        levels: { hermetismo: 'gone', alquimia: 'x' },
      }),
    ).toEqual({ hermetismo: 'gone' });
    expect(service.staleLevels({})).toEqual({});
  });
});

describe('PeopleLevelsService.assign (KBC-109 FR-3)', () => {
  it('logs and fails when the audit cannot record a bulk already written', async () => {
    const audit = new MemoryLevelAudit();
    vi.spyOn(audit, 'appendMany').mockRejectedValue(new Error('disk full'));
    const { service } = await world(audit);
    const error = vi.fn();

    await expect(
      service.assign(
        { actor: { by: 'owner@example.com' }, log: { error } },
        { all: true, topic: 'hermetismo', level: 'ci' },
      ),
    ).rejects.toThrow('disk full');
    expect(error).toHaveBeenCalledWith(
      expect.objectContaining({ collection: 'hermetismo', people: ['ana'] }),
      'people levels changed but not audited',
    );
  });

  it('refuses a sub-collection: the scale is its parent’s', async () => {
    const { service } = await world();
    await expect(
      service.assign(
        { actor: { by: 'o' }, log: { error: vi.fn() } },
        { all: true, topic: 'hermetismo/aulas', level: 'ci' },
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });
});
