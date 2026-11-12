import { describe, expect, it } from 'vitest';
import { MemoryDocumentStore } from './adapters/memory-document-store.js';
import { MemoryLevelAudit } from './adapters/memory-level-audit.js';
import { openMediaDatabase } from './adapters/sqlite/media-database.js';
import { MEDIA_MIGRATIONS } from './adapters/sqlite/media-migrations.js';
import { SqliteMediaStore } from './adapters/sqlite/sqlite-media-store.js';
import type { StoredPerson } from './modules/auth/index.js';
import { CatalogRegistry } from './modules/catalog/index.js';
import { ContentGate } from './modules/access-levels/content-gate.js';
import { LevelDirectory } from './modules/access-levels/level-directory.js';
import { ScaleChangesService } from './modules/access-levels/scale-changes-service.js';
import { scaleVersion } from './modules/access-levels/scale-version.js';
import { LevelWriteQueue } from './modules/access-levels/write-queue.js';

/*
 * KBC-108 NFR-1: the preview of a collection with 10,000 documents, 2,000 audios and 500
 * people answers in p95 ≤ 300 ms. The gates run on a shared machine with twice the limit;
 * `KBC_NFR_STRICT=1` holds the item's own limit.
 */

const DOCUMENTS = 10_000;
const AUDIOS = 2_000;
const PEOPLE = 500;
const RUNS = 20;
const AT = '2026-11-11T12:00:00.000Z';
const LIMIT_MS = process.env['KBC_NFR_STRICT'] === '1' ? 300 : 600;
const LEVELS = ['qs', 'ci', 'cdc', 'qm', 'qm-plus'];

const person = (n: number): StoredPerson => ({
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
  levels: { hermetismo: LEVELS[n % LEVELS.length] ?? 'qs' },
});

async function world() {
  const ids = Array.from({ length: DOCUMENTS }, (_, n) => `raw/d-${n}.md`);
  const catalog = new CatalogRegistry({
    listTopics: async () => [{ slug: 'hermetismo', title: 'Hermetismo' }],
    listDocuments: async () => ids,
    readDocument: async (_topic, id) => `---\ntitle: Doc ${id}\n---\n`,
  });
  await catalog.load();
  const directory = new LevelDirectory({
    scales: new MemoryDocumentStore(),
    documents: new MemoryDocumentStore(),
    presence: new MemoryDocumentStore(),
  });
  await directory.load();
  const scale = LEVELS.map((id) => ({
    id,
    code: id.toUpperCase(),
    description: '',
    createdBy: 'owner@example.com',
    createdAt: AT,
  }));
  await directory.changeScale('hermetismo', () => ({
    next: scale,
    result: undefined,
  }));
  await directory.place({
    hermetismo: Object.fromEntries(
      ids.map((id, n) => [
        id,
        { level: LEVELS[n % LEVELS.length] ?? 'qs', setBy: 'x', setAt: AT },
      ]),
    ),
  });
  const db = openMediaDatabase(':memory:', MEDIA_MIGRATIONS);
  const insert = db.prepare(
    `INSERT INTO media (id, topic, title, authorship, owner_principal, file_name,
       upload_bytes, status, duration_ms, bytes, level, created_at, updated_at)
     VALUES (?, 'hermetismo', 'Palestra', 'outros-autores', 'seed', 'a.mp3', 1, 'ready', 1, 1, ?, ?, ?)`,
  );
  db.exec('BEGIN');
  for (let n = 0; n < AUDIOS; n++)
    insert.run(`m-${n}`, LEVELS[n % LEVELS.length] ?? 'qs', AT, AT);
  db.exec('COMMIT');
  const people = Array.from({ length: PEOPLE }, (_, n) => person(n));
  const service = new ScaleChangesService({
    queue: new LevelWriteQueue(),
    directory,
    catalog,
    gate: new ContentGate({ directory, catalog }),
    parentOf: () => null,
    people: { list: async () => people, rewriteLevels: async () => [] },
    media: new SqliteMediaStore(db),
    audit: new MemoryLevelAudit(),
  });
  return { service, version: scaleVersion(directory.scaleOf('hermetismo')) };
}

const p95 = (times: number[]): number => {
  const sorted = [...times].sort((a, b) => a - b);
  return sorted[Math.ceil(sorted.length * 0.95) - 1] ?? Infinity;
};

describe('Scale change preview latency (KBC-108 NFR-1)', () => {
  it(`previews a reorder and a removal over 10,000 documents, 2,000 audios and 500 people in p95 ≤ ${LIMIT_MS} ms`, async () => {
    const { service, version } = await world();
    const order = ['qs', 'cdc', 'ci', 'qm', 'qm-plus'];
    const first = await service.preview('hermetismo', { order, version });
    expect(first.gaining).toEqual({ people: 100, documents: 2000, media: 400 });
    const times: number[] = [];
    for (let run = 0; run < RUNS; run += 1) {
      const started = performance.now();
      await service.preview('hermetismo', { order, version });
      await service.preview('hermetismo', { remove: 'ci', version });
      times.push((performance.now() - started) / 2);
    }
    const measured = p95(times);
    console.info(`KBC-108 NFR-1: preview p95 = ${measured.toFixed(2)} ms`);
    expect(measured).toBeLessThanOrEqual(LIMIT_MS);
  });
});
