import { describe, expect, it, vi } from 'vitest';
import { MemoryDocumentRemovalStore } from '../../adapters/json-document-removal-store.js';
import type { VaultReaderPort } from '../../ports/vault-reader.js';
import { CatalogRegistry } from '../catalog/index.js';
import { RemovalQueue } from './removal-queue.js';
import { RemovalRecords } from './removal-records.js';
import { RemovalService } from './removal-service.js';
import { RemovedVault } from './removed-vault.js';
import { VaultJobs } from './vault-jobs.js';

const TRACK = '1c8e6d2f-4a3b-4d6c-9e7f-8091a2b3c4d5';
const DOCUMENTS: Record<string, Record<string, string>> = {
  hermetismo: {
    'raw/livro.md': '---\ntitle: O Livro\ntype: source\n---\n',
    'raw/media/faixa.md': `---\ntitle: A Faixa\ntype: source\nkb_chat_media_id: ${TRACK}\nkb_chat_fingerprint: ${'a'.repeat(64)}\n---\n`,
    'wiki/concepts/ritmo.md': '---\ntitle: Ritmo\ntype: concept\n---\n',
  },
  'hermetismo/aulas': {
    'raw/aula.md': '---\ntitle: A Aula\ntype: source\n---\n',
  },
};

/** What holds the readings of the vault: each one past the removals' check waits for `wait`. */
interface Gate {
  wait?: Promise<void>;
  /** Told when a held reading began. */
  reached?: () => void;
}

/** The collection and its sub-collection; `gate` holds a reading until it is let go. */
function vaultOf(gate: Gate = {}): VaultReaderPort {
  return {
    listTopics: () =>
      Promise.resolve([
        { slug: 'hermetismo', title: 'Hermetismo' },
        { slug: 'hermetismo/aulas', title: 'Aulas', parent: 'hermetismo' },
      ]),
    listDocuments: (topic) =>
      Promise.resolve(Object.keys(DOCUMENTS[topic] ?? {})),
    readDocument: async (topic, id) => {
      const held = gate.wait;
      if (held) gate.reached?.();
      await held;
      return DOCUMENTS[topic]?.[id] ?? null;
    },
  };
}

const master = {
  principal: 'dono',
  email: 'dono@example.com',
  name: 'Dono',
  canSee: () => true,
  seesDocument: () => true,
};

async function world(gate: Gate = {}) {
  const records = await RemovalRecords.open(new MemoryDocumentRemovalStore());
  const catalog = new CatalogRegistry(
    new RemovedVault(vaultOf(gate), records),
    (topic, id) => records.isRemoved(topic, id),
  );
  await catalog.load();
  const placeLevel = vi.fn(() => Promise.resolve());
  const service = new RemovalService({
    records,
    catalog,
    placeLevel,
    levelOf: (_topic, id) => (id === 'raw/livro.md' ? 'qm' : null),
  });
  const has = (topic: string, id: string) =>
    catalog.get(topic)?.entries.has(id) === true;
  return { records, catalog, service, placeLevel, has };
}

describe('RemovalService (KBC-187)', () => {
  it('keeps the level the document has, for when it is back', async () => {
    const { service, records, placeLevel } = await world();
    const { id } = await service.remove(master, 'hermetismo', 'raw/livro.md');
    expect(records.get(id)?.level).toBe('qm');
    expect(await service.restore(master, id)).toBeNull();
    expect(placeLevel).toHaveBeenCalledWith(
      expect.objectContaining({ level: 'qm' }),
    );
  });

  it("finds a sub-collection's by its id in the parent, and removes it where it is", async () => {
    const { service, records, has } = await world();
    await service.remove(master, 'hermetismo', 'aulas/raw/aula.md');
    expect(records.isRemoved('hermetismo/aulas', 'raw/aula.md')).toBe(true);
    expect(has('hermetismo/aulas', 'raw/aula.md')).toBe(false);
    expect(has('hermetismo', 'raw/livro.md')).toBe(true);
  });

  it.each(['raw/media/faixa.md', 'wiki/concepts/ritmo.md', 'raw/nada.md'])(
    'has nothing to remove at %s (BR-7)',
    async (id) => {
      const { service, records } = await world();
      await expect(
        service.remove(master, 'hermetismo', id),
      ).rejects.toMatchObject({ code: 'DOCUMENT_NOT_FOUND' });
      expect(records.all()).toEqual([]);
    },
  );

  it('removed again while the Mac brings it back, what the Mac does is not lost', async () => {
    const { service, records } = await world();
    const { id } = await service.remove(master, 'hermetismo', 'raw/livro.md');
    const queue = new RemovalQueue({ records });
    queue.lease('mac');
    const lease = records.get(id)?.lease;
    await service.restore(master, id);
    const again = await service.remove(master, 'hermetismo', 'raw/livro.md');
    expect(again.id).toBe(id);
    expect(records.get(id)).toMatchObject({ lease, isQuarantined: null });
  });
});

/** Holds the readings from now on; `reached` once one is past the removals' check. */
function hold(gate: Gate): { go: () => void; reached: Promise<void> } {
  let go: () => void = () => undefined;
  gate.wait = new Promise((resolve) => {
    go = resolve;
  });
  const reached = new Promise<void>((resolve) => {
    gate.reached = resolve;
  });
  return { go, reached };
}

describe('a reading of the collection under way (I-1, R2-I1)', () => {
  it('never brings back what was removed meanwhile', async () => {
    const gate: Gate = {};
    const { service, catalog, has } = await world(gate);
    const held = hold(gate);
    const loading = catalog.load();
    // The reading is past the vault's own check: only the catalog may leave it out now.
    await held.reached;
    await service.remove(master, 'hermetismo', 'raw/livro.md');
    expect(has('hermetismo', 'raw/livro.md')).toBe(false);
    held.go();
    await loading;
    expect(has('hermetismo', 'raw/livro.md')).toBe(false);
  });

  it('never hides what came back while an older reading went on', async () => {
    const gate: Gate = {};
    const { service, catalog, has } = await world(gate);
    const { id } = await service.remove(master, 'hermetismo', 'raw/livro.md');
    const held = hold(gate);
    // Read while it was out: this reading has nothing of it.
    const loading = catalog.load();
    await held.reached;
    gate.wait = undefined;
    // Back now, with no Mac asked: its own reading would end first, were they not in turn.
    const back = service.restore(master, id);
    held.go();
    await Promise.all([loading, back]);
    expect(has('hermetismo', 'raw/livro.md')).toBe(true);
  });
});

describe('VaultJobs (KBC-187)', () => {
  async function jobs(docs: { leasable: number; held: boolean }) {
    const { service, records } = await world();
    const entered = vi.fn(() => Promise.resolve());
    const removals = new RemovalQueue({ records });
    const made = new VaultJobs({
      removals,
      entered,
      docs: {
        leasableJobs: () => docs.leasable,
        isHeldBy: () => docs.held,
        lease: () => ({ id: 'doc' }),
        isJob: (id: string) => id === 'doc',
        complete: () => Promise.resolve(),
      } as never,
    });
    return { made, service, entered };
  }

  it('wakes the Mac for a removal alone, and gives it one thing at a time', async () => {
    const { made, service } = await jobs({ leasable: 0, held: false });
    expect(made.leasableJobs()).toBe(0);
    const { id } = await service.remove(master, 'hermetismo', 'raw/livro.md');
    expect(made.leasableJobs()).toBe(1);
    expect(made.isHeldBy('mac')).toBe(false);
    // It costs nothing and takes seconds: before what was sent.
    expect(made.lease('mac')?.id).toBe(id);
    expect(made.lease('other')?.id).toBe('doc');
    expect(made.isHeldBy('mac')).toBe(true);
    expect([made.isJob(id), made.isJob('doc'), made.isJob('x')]).toEqual([
      true,
      true,
      false,
    ]);
  });

  it('counts and holds what was sent too, and tells what entered', async () => {
    const { made, entered } = await jobs({ leasable: 2, held: true });
    expect(made.leasableJobs()).toBe(2);
    expect(made.isHeldBy('mac')).toBe(true);
    const owner = { jobId: 'doc', worker: 'mac', leaseId: 'l' };
    const lease = { worker: 'mac', leaseId: 'l', spendUsd: 0 };
    await made.complete(owner, {
      ...lease,
      outcome: {
        state: 'ready',
        document: { id: 'raw/livro.md', title: 'O Livro' },
        review: false,
      },
    });
    expect(entered).toHaveBeenCalledWith('doc', 'raw/livro.md');
  });
});
