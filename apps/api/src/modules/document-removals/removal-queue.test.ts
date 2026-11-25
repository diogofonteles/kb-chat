import { describe, expect, it, vi } from 'vitest';
import { MemoryDocumentRemovalStore } from '../../adapters/json-document-removal-store.js';
import type { RemovalRecord } from '../../ports/document-removals.js';
import { REMOVAL_LEASE_MS, RemovalQueue } from './removal-queue.js';
import { RemovalRecords } from './removal-records.js';
import { RemovalService } from './removal-service.js';
import { RemovedVault } from './removed-vault.js';

const ID = '11111111-1111-4111-8111-111111111111';
const record = (fields: Partial<RemovalRecord> = {}): RemovalRecord => ({
  id: ID,
  topic: 'hermetismo',
  document: { id: 'raw/livro.md', title: 'O Livro' },
  source: { sha256: null, url: null },
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
    expect(again.isRemoved('hermetismo', 'raw/livro.md')).toBe(true);
  });
});

describe('a Mac that moved it and never said so (B-1)', () => {
  const master = {
    principal: 'dono',
    email: 'dono@example.com',
    name: 'Dono',
    canSee: () => true,
    seesDocument: () => true,
  };

  async function withService() {
    const made = await world();
    const refreshed = vi.fn(() => Promise.resolve());
    const service = new RemovalService({
      records: made.records,
      catalog: { refresh: refreshed, get: () => undefined } as never,
      levelOf: () => null,
    });
    return { ...made, service };
  }

  it('asked back after it fell, it is brought back', async () => {
    const { queue, service, later, records, owner } = await withService();
    queue.lease('mac');
    expect(await service.restore(master, ID)).toMatchObject({
      state: 'restoring',
    });
    later(REMOVAL_LEASE_MS + 1);
    expect(queue.lease('mac')?.source.kind).toBe('restore');
    await queue.complete(owner(), MOVED);
    expect(records.all()).toEqual([]);
  });

  it('asked back after the attempt failed half-way, it is brought back', async () => {
    const { queue, service, owner } = await withService();
    queue.lease('mac');
    await queue.fail(owner(), { detail: 'kb index: no' });
    expect(await service.restore(master, ID)).toMatchObject({
      state: 'restoring',
    });
    expect(queue.lease('mac')?.source.kind).toBe('restore');
  });

  it('asked back while it works, and then it fails, it is brought back', async () => {
    const { queue, service, owner } = await withService();
    queue.lease('mac');
    await service.restore(master, ID);
    await queue.fail(owner(), { detail: 'kb index: no' });
    expect(queue.leasableJobs()).toBe(1);
    expect(queue.lease('mac')?.source.kind).toBe('restore');
  });

  it('never asked of a Mac, it is back with nothing to move', async () => {
    const { service, records, queue } = await withService();
    expect(await service.restore(master, ID)).toBeNull();
    expect(records.all()).toEqual([]);
    expect(queue.leasableJobs()).toBe(0);
  });
});

describe('two things asked at once (I-3)', () => {
  it('removed again while its level is placed, it stays removed', async () => {
    const made = await world({ wish: 'present', isQuarantined: true });
    const { queue, records, owner } = made;
    made.placeLevel.mockImplementation(async () => {
      await records.update(ID, (one) => ({ ...one, wish: 'removed' }));
    });
    queue.lease('mac');
    await queue.complete(owner(), MOVED);
    expect(records.get(ID)).toMatchObject({
      wish: 'removed',
      isQuarantined: false,
    });
    expect(queue.lease('mac')?.source.kind).toBe('remove');
  });

  it('an outcome of a document is none of a removal', async () => {
    const { queue, owner } = await world();
    queue.lease('mac');
    const ready = {
      state: 'ready' as const,
      document: { id: 'raw/x.md', title: 'x' },
      review: false,
    };
    await expect(
      queue.complete(owner(), { outcome: ready }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });
});

describe('what failed is not what is asked now (S-r2-2)', () => {
  it('a failure of the way out, asked back meanwhile, only lets the Mac go', async () => {
    const { queue, records, owner } = await world();
    queue.lease('mac');
    await records.update(ID, (one) => ({ ...one, wish: 'present' }));
    await queue.complete(owner(), {
      outcome: {
        state: 'failed',
        failure: 'conversion-failed',
        detail: 'kb: locked',
      },
    });
    expect(records.get(ID)).toMatchObject({ failed: false, attempts: 0 });
    expect(queue.lease('mac')?.source.kind).toBe('restore');
    await queue.fail(owner(), { detail: 'crash' });
    expect(records.get(ID)).toMatchObject({ failed: false });
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
    // It is how a search under way reads it (I-2).
    const vault = new RemovedVault(
      {
        listTopics: () => Promise.resolve([]),
        listDocuments: () => Promise.resolve([]),
        readDocument: () => Promise.resolve('texto'),
      },
      records,
    );
    expect(
      await vault.readDocument('hermetismo', 'aulas/raw/livro.md'),
    ).toBeNull();
    expect(
      await vault.readDocument('hermetismo/aulas', 'raw/livro.md'),
    ).toBeNull();
    expect(records.isRemovedIn('hermetismo', 'raw/livro.md')).toBe(false);
  });
});
