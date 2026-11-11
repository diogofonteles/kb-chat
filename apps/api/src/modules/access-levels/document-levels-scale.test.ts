import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { describe, expect, it } from 'vitest';
import { FsLevelAudit } from '../../adapters/fs-level-audit.js';
import { JsonDocumentStore } from '../../adapters/json-document-store.js';
import type { StoredPerson } from '../auth/index.js';
import { CatalogRegistry } from '../catalog/index.js';
import { ContentGate } from './content-gate.js';
import { DocumentLevelsService } from './document-levels-service.js';
import { LevelDirectory } from './level-directory.js';

/**
 * KBC-107 NFR-1 and NFR-2 on a synthetic collection of 5,000 documents without a level: one
 * page of "Sem nível" answers p95 ≤ 150 ms, and 2,000 documents get a level in ≤ 2 s with one
 * write of `document-levels.json`.
 */
const DOCUMENTS = 5000;

/** The real files (atomic JSON, synced audit), counting the writes of the levels file. */
class CountingStore extends JsonDocumentStore {
  writes = 0;

  override async write(value: object): Promise<void> {
    this.writes += 1;
    await super.write(value);
  }
}

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

const ids = Array.from(
  { length: DOCUMENTS },
  (_, n) => `raw/${n % 7 === 0 ? 'audio' : 'texto'}/doc-${n}.md`,
);

async function world() {
  const state = await mkdtemp(join(tmpdir(), 'kbchat-levels-scale-'));
  const documents = new CountingStore(join(state, 'document-levels.json'));
  const directory = new LevelDirectory({
    scales: new JsonDocumentStore(join(state, 'access-levels.json')),
    documents,
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
    listDocuments: async () => ids,
    readDocument: async (_topic, id) =>
      `---\ntitle: Documento ${id}\nsource_path: ${id.includes('audio') ? 'audio/' : ''}x.mp3\n---\n`,
  });
  await catalog.load();
  const gate = new ContentGate({ directory, catalog });
  const service = new DocumentLevelsService({
    directory,
    catalog,
    gate,
    audit: new FsLevelAudit(join(state, 'audit')),
    parentOf: () => null,
  });
  await service.reconcile();
  return { service, documents };
}

const p95 = (samples: number[]) =>
  [...samples].sort((a, b) => a - b)[Math.ceil(samples.length * 0.95) - 1] ??
  Infinity;

describe('"Sem nível" at scale (KBC-107 NFR-1, NFR-2)', () => {
  it('NFR-2: a page of a 5,000-document queue answers p95 ≤ 150 ms, filtered or not', async () => {
    const { service } = await world();
    const samples: number[] = [];
    let cursor: string | undefined;
    for (let round = 0; round < 20; round += 1) {
      const started = performance.now();
      const page = await service.unassigned(master, 'hermetismo', {
        ...(round % 2 === 1 && { origin: 'audio' }),
        ...(cursor && round % 2 === 0 && { cursor }),
        limit: 50,
      });
      samples.push(performance.now() - started);
      expect(page.total).toBe(DOCUMENTS);
      if (round % 2 === 0) cursor = page.nextCursor ?? undefined;
    }
    console.info(`NFR-2 p95 ${p95(samples).toFixed(1)} ms over 20 pages`);
    expect(p95(samples)).toBeLessThanOrEqual(150);
  });

  it('NFR-1: 2,000 documents get a level in ≤ 2 s with one write of the levels file', async () => {
    const { service, documents } = await world();
    const before = documents.writes;
    const started = performance.now();
    const result = await service.bulk(
      { actor: { by: 'owner@example.com' }, person: master },
      'hermetismo',
      {
        level: 'ci',
        ids: ids.slice(0, 2000).map((id) => ({ topic: 'hermetismo', id })),
      },
    );
    const elapsed = performance.now() - started;
    console.info(`NFR-1 ${elapsed.toFixed(1)} ms for 2,000 documents`);
    expect(result).toMatchObject({ updated: 2000, skipped: 0 });
    expect(documents.writes - before).toBe(1);
    expect(elapsed).toBeLessThanOrEqual(2000);
    const left = await service.unassigned(master, 'hermetismo', {});
    expect(left.total).toBe(DOCUMENTS - 2000);
  });
});
