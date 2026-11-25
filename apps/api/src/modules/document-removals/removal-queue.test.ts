import { describe, expect, it, vi } from 'vitest';
import { MemoryDocumentRemovalStore } from '../../adapters/json-document-removal-store.js';
import type { RemovalRecord } from '../../ports/document-removals.js';
import { REMOVAL_LEASE_MS, RemovalQueue } from './removal-queue.js';
import { RemovalRecords } from './removal-records.js';
import { RemovedVault } from './removed-vault.js';

const ID = '11111111-1111-4111-8111-111111111111';
const record = (fields: Partial<RemovalRecord> = {}): RemovalRecord => ({
  id: ID,
  topic: 'hermetismo',
  document: { id: 'raw/livro.md', title: 'O Livro' },
  level: null,
  by: { email: 'dono@example.com', name: 'Dono' },
  removedAt: '2026-11-25T12:00:00.000Z',
  wish: 'removed',
  isQuarantined: false,
  lease: null,
  attempts: 0,
  failed: false,
  detail: null,
  ...fields,
});

async function world(fields: Partial<RemovalRecord> = {}) {
  const store = new MemoryDocumentRemovalStore();
  store.records = [record(fields)];
  const records = await RemovalRecords.open(store);
  const clock = { now: new Date('2026-11-25T12:01:00.000Z') };
  const placeLevel = vi.fn(() => Promise.resolve());
  const moved = vi.fn();
  const queue = new RemovalQueue({
    records,
    placeLevel,
    moved,
    now: () => clock.now,
  });
  const later = (ms: number) => {
    clock.now = new Date(clock.now.getTime() + ms);
  };
  const owner = () => ({
    jobId: ID,
    worker: 'mac',
    leaseId: records.get(ID)?.lease?.leaseId ?? '',
  });
  return { queue, records, later, owner, placeLevel, moved, store };
}

const MOVED = { outcome: { state: 'moved' as const } };

describe('RemovalQueue (KBC-187)', () => {
  it('is one lease at a time, kept by its beats', async () => {
    const { queue, later, owner } = await world();
    expect(queue.leasableJobs()).toBe(1);
    expect(queue.lease('mac')).toMatchObject({ id: ID, attempt: 1 });
    expect(queue.lease('other')).toBeNull();
    expect(queue.isHeldBy('mac')).toBe(true);
    later(REMOVAL_LEASE_MS - 1_000);
    queue.heartbeat(owner());
    later(REMOVAL_LEASE_MS - 1_000);
    expect(queue.leasableJobs()).toBe(0);
  });

  it('a lease lost is an attempt: after three it says so, and keeps hiding it', async () => {
    const { queue, records, later } = await world();
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      expect(queue.lease('mac')?.attempt).toBe(attempt);
      later(REMOVAL_LEASE_MS + 1);
    }
    expect(queue.lease('mac')).toBeNull();
    expect(records.get(ID)).toMatchObject({ failed: true, lease: null });
    expect(records.isRemoved('hermetismo', 'raw/livro.md')).toBe(true);
  });

  it('a crash counts, the Mac not set up does not', async () => {
    const { queue, records, owner } = await world();
    for (let time = 0; time < 5; time += 1) {
      queue.lease('mac');
      await queue.fail(owner(), { detail: 'no kb key', configuration: true });
    }
    expect(records.get(ID)).toMatchObject({ attempts: 0, failed: false });
    for (let time = 0; time < 3; time += 1) {
      queue.lease('mac');
      await queue.fail(owner(), { detail: 'kb: no' });
    }
    expect(records.get(ID)).toMatchObject({ failed: true, detail: 'kb: no' });
  });

  it('an old lease moves nothing', async () => {
    const { queue, owner, later } = await world();
    queue.lease('mac');
    const old = owner();
    later(REMOVAL_LEASE_MS + 1);
    queue.lease('mac');
    await expect(queue.complete(old, MOVED)).rejects.toMatchObject({
      code: 'MEDIA_CONFLICT',
    });
    expect(() => queue.heartbeat(old)).toThrow();
    await expect(queue.fail(old, { detail: 'x' })).rejects.toMatchObject({
      code: 'MEDIA_CONFLICT',
    });
  });

  it('back, it has the level it had, and its removal is over', async () => {
    const { queue, records, owner, placeLevel, moved } = await world({
      wish: 'present',
      isQuarantined: true,
      level: 'qm',
    });
    expect(queue.lease('mac')?.source.kind).toBe('restore');
    await queue.complete(owner(), MOVED);
    expect(placeLevel).toHaveBeenCalledWith(
      expect.objectContaining({ level: 'qm' }),
    );
    expect(moved).toHaveBeenCalledWith('hermetismo');
    expect(records.all()).toEqual([]);
  });

  it('survives a restart as it was', async () => {
    const { queue, store, owner } = await world();
    queue.lease('mac');
    await queue.complete(owner(), MOVED);
    const again = await RemovalRecords.open(store);
    expect(again.get(ID)).toMatchObject({ isQuarantined: true, lease: null });
  });
});

describe('RemovedVault (KBC-187)', () => {
  it('has no such document, however its path is spelled', async () => {
    const { records } = await world();
    const inside = {
      listTopics: () => Promise.resolve([]),
      listDocuments: () => Promise.resolve(['raw/livro.md', 'raw/outro.md']),
      readDocument: () => Promise.resolve('texto'),
    };
    const vault = new RemovedVault(inside, records);
    expect(await vault.listDocuments('hermetismo')).toEqual(['raw/outro.md']);
    for (const id of [
      'raw/livro.md',
      './raw/livro.md',
      'raw//livro.md',
      'raw/x/../livro.md',
    ])
      expect(await vault.readDocument('hermetismo', id)).toBeNull();
    expect(await vault.readDocument('hermetismo', 'raw/outro.md')).toBe(
      'texto',
    );
    expect(await vault.readDocument('outro', 'raw/livro.md')).toBe('texto');
    expect(records.isRemovedIn('hermetismo', 'raw/livro.md')).toBe(true);
  });

  it("knows a sub-collection's by its id in the parent", async () => {
    const { records } = await world({ topic: 'hermetismo/aulas' });
    expect(records.isRemovedIn('hermetismo', 'aulas/raw/livro.md')).toBe(true);
    expect(records.isRemovedIn('hermetismo', 'raw/livro.md')).toBe(false);
  });
});
