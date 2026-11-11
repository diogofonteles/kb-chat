import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { describe, expect, it } from 'vitest';
import { FsLevelAudit } from '../../adapters/fs-level-audit.js';
import { JsonDocumentStore } from '../../adapters/json-document-store.js';
import { JsonPeopleStore } from '../../adapters/json-people-store.js';
import { PeopleService, type StoredPerson } from '../auth/index.js';
import { CatalogRegistry } from '../catalog/index.js';
import { ContentGate } from './content-gate.js';
import { LevelDirectory } from './level-directory.js';
import { PeopleLevelsService } from './people-levels-service.js';

/**
 * KBC-109 NFR-1 on 500 members of a collection with a scale, over the real files (atomic
 * people.json, synced audit), as KBC-107 measures its bulk: one write of people.json and one
 * append of the audit. The time is printed; the gate holds it to 5 s (five times the NFR, a
 * shared machine), and `KBC_NFR_STRICT=1` holds it to the NFR's 1 s (work/KBC-109/nfr.txt).
 */
const PEOPLE = 500;
const LIMIT_MS = process.env['KBC_NFR_STRICT'] === '1' ? 1000 : 5000;

class CountingPeople extends JsonPeopleStore {
  writes = 0;

  override async write(value: object): Promise<void> {
    this.writes += 1;
    await super.write(value);
  }
}

class CountingAudit extends FsLevelAudit {
  appends = 0;

  override async appendMany(
    ...entries: Parameters<FsLevelAudit['appendMany']>
  ): Promise<void> {
    this.appends += 1;
    await super.appendMany(...entries);
  }
}

const member = (n: number): StoredPerson => ({
  id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
  sub: null,
  email: `p${n}@example.com`,
  name: '',
  picture: null,
  role: 'member',
  topics: ['hermetismo'],
  features: ['search'],
  invitedBy: 'owner@example.com',
  createdAt: '2026-11-01T00:00:00.000Z',
  lastLoginAt: null,
});

async function world() {
  const state = await mkdtemp(join(tmpdir(), 'kbchat-people-levels-'));
  const many = Array.from({ length: PEOPLE }, (_, n) => member(n));
  await writeFile(
    join(state, 'people.json'),
    JSON.stringify({ version: 1, people: many }),
  );
  const store = new CountingPeople(join(state, 'people.json'));
  const people = new PeopleService({ store });
  const directory = new LevelDirectory({
    scales: new JsonDocumentStore(join(state, 'access-levels.json')),
    documents: new JsonDocumentStore(join(state, 'document-levels.json')),
    presence: new JsonDocumentStore(join(state, 'document-presence.json')),
  });
  await directory.load();
  await directory.changeScale('hermetismo', () => ({
    next: ['QS', 'CI'].map((code) => ({
      id: code.toLowerCase(),
      code,
      description: '',
      createdBy: 'owner@example.com',
      createdAt: '2026-11-01T00:00:00.000Z',
    })),
    result: undefined,
  }));
  const catalog = new CatalogRegistry({
    listTopics: async () => [{ slug: 'hermetismo', title: 'Hermetismo' }],
    listDocuments: async () => [],
    readDocument: async () => '---\ntitle: A\n---\n',
  });
  await catalog.load();
  const audit = new CountingAudit(join(state, 'audit'));
  const service = new PeopleLevelsService({
    directory,
    catalog,
    gate: new ContentGate({ directory, catalog }),
    audit,
    parentOf: () => null,
    people,
  });
  await people.list();
  return { service, store, audit, ids: many.map((one) => one.id) };
}

describe('People levels at scale (KBC-109 NFR-1)', () => {
  it('a level for 500 people: one write of people.json, one append of the audit, within the limit', async () => {
    const { service, store, audit, ids } = await world();
    const writes = store.writes;
    const started = performance.now();
    const result = await service.assign(
      { actor: { by: 'owner@example.com' }, log: { error: () => undefined } },
      { ids, topic: 'hermetismo', level: 'ci' },
    );
    const elapsed = performance.now() - started;
    console.info(`NFR-1 ${elapsed.toFixed(1)} ms for ${PEOPLE} people`);
    expect(result).toMatchObject({ updated: PEOPLE, unknown: 0 });
    expect(store.writes - writes).toBe(1);
    expect(audit.appends).toBe(1);
    expect(elapsed).toBeLessThanOrEqual(LIMIT_MS);
  });
});
