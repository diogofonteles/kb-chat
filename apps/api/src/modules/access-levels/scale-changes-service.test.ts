import { describe, expect, it } from 'vitest';
import { MemoryDocumentStore } from '../../adapters/memory-document-store.js';
import { MemoryLevelAudit } from '../../adapters/memory-level-audit.js';
import type { StoredPerson } from '../auth/index.js';
import { CatalogRegistry } from '../catalog/index.js';
import { ContentGate } from './content-gate.js';
import { LevelDirectory } from './level-directory.js';
import { ScaleChangesService } from './scale-changes-service.js';
import { scaleVersion } from './scale-version.js';
import { LevelWriteQueue } from './write-queue.js';

/*
 * KBC-108 review R1-1: whoever holds no level, or one the scale no longer has, sits at the
 * lowest level of whatever the scale is. A preview counts them there, before and after.
 */

const AT = '2026-11-11T12:00:00.000Z';
const person = (n: number, levels?: Record<string, string>): StoredPerson => ({
  id: `0f0e0d0c-0b0a-4908-8706-${String(n).padStart(12, '0')}`,
  sub: null,
  email: `p${n}@example.com`,
  name: `P${n}`,
  picture: null,
  role: 'member',
  topics: ['hermetismo'],
  features: ['search'],
  invitedBy: 'owner@example.com',
  createdAt: AT,
  lastLoginAt: null,
  ...(levels && { levels }),
});

/** QS (5 texts) < CI (7) < CDC (0), and the people given. */
async function world(people: readonly StoredPerson[]) {
  const qs = Array.from({ length: 5 }, (_, n) => `raw/qs-${n}.md`);
  const ci = Array.from({ length: 7 }, (_, n) => `raw/ci-${n}.md`);
  const catalog = new CatalogRegistry({
    listTopics: async () => [{ slug: 'hermetismo', title: 'Hermetismo' }],
    listDocuments: async () => [...qs, ...ci],
    readDocument: async (_topic, id) => `---\ntitle: Doc ${id}\n---\n`,
  });
  await catalog.load();
  const directory = new LevelDirectory({
    scales: new MemoryDocumentStore(),
    documents: new MemoryDocumentStore(),
    presence: new MemoryDocumentStore(),
  });
  await directory.load();
  const level = (id: string) => ({
    id,
    code: id.toUpperCase(),
    description: '',
    createdBy: 'owner@example.com',
    createdAt: AT,
  });
  await directory.changeScale('hermetismo', () => ({
    next: [level('qs'), level('ci'), level('cdc')],
    result: undefined,
  }));
  const placed = (lvl: string) => ({ level: lvl, setBy: 'x', setAt: AT });
  await directory.place({
    hermetismo: Object.fromEntries([
      ...qs.map((id) => [id, placed('qs')]),
      ...ci.map((id) => [id, placed('ci')]),
    ]),
  });
  const service = new ScaleChangesService({
    queue: new LevelWriteQueue(),
    directory,
    catalog,
    gate: new ContentGate({ directory, catalog }),
    parentOf: () => null,
    people: { list: async () => people, rewriteLevels: async () => [] },
    audit: new MemoryLevelAudit(),
  });
  return { service, version: scaleVersion(directory.scaleOf('hermetismo')) };
}

const ANA_WITHOUT_LEVEL = person(1);
const ANA_AT_A_GONE_LEVEL = person(1, { hermetismo: 'gone' });

describe('ScaleChangesService preview: people with no level of the scale (R1-1)', () => {
  it.each([
    ['no level recorded', ANA_WITHOUT_LEVEL],
    ['a level the scale no longer has', ANA_AT_A_GONE_LEVEL],
  ])(
    'moving the lowest level up: Ana, with %s, loses QS and gains CI',
    async (_case, ana) => {
      const { service, version } = await world([ana]);
      const preview = await service.preview('hermetismo', {
        order: ['ci', 'qs', 'cdc'],
        version,
      });
      expect(preview.losing).toEqual({ people: 1, documents: 5, media: 0 });
      expect(preview.gaining).toEqual({ people: 1, documents: 7, media: 0 });
    },
  );

  it('deleting the lowest with its people sent to CI and its content to CDC: Ana loses QS', async () => {
    const { service, version } = await world([ANA_WITHOUT_LEVEL]);
    const preview = await service.preview('hermetismo', {
      remove: 'qs',
      version,
    });
    expect(preview.removal).toMatchObject({ people: 1 });
    // The defaults: QS content to CI, people to CI; Ana then sees CI, QS's texts included.
    expect(preview.losing).toEqual({ people: 0, documents: 0, media: 0 });
    expect(preview.gaining).toEqual({ people: 1, documents: 7, media: 0 });
  });

  it('deleting a middle level leaves Ana at the lowest, untouched', async () => {
    const { service, version } = await world([ANA_WITHOUT_LEVEL]);
    const preview = await service.preview('hermetismo', {
      remove: 'ci',
      version,
    });
    expect(preview.removal).toMatchObject({ people: 0 });
    expect(preview.gaining.people + preview.losing.people).toBe(0);
  });

  it('taking every level away: Ana gains CI', async () => {
    const { service, version } = await world([ANA_WITHOUT_LEVEL]);
    const preview = await service.preview('hermetismo', { all: true, version });
    expect(preview.gaining).toEqual({ people: 1, documents: 7, media: 0 });
    expect(preview.losing).toEqual({ people: 0, documents: 0, media: 0 });
    expect(preview.removal).toBeNull();
  });
});
