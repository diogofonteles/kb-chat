import { describe, expect, it } from 'vitest';
import { MemoryDocumentUploadStore } from '../../adapters/json-document-upload-store.js';
import type {
  DocumentUploadFilesPort,
  DocumentUploadRecord,
} from '../../ports/document-uploads.js';
import { DOC_INGEST_LEASE_MS, DocIngestQueue } from './doc-ingest-queue.js';
import { UploadRecords } from './upload-records.js';
import { toDocumentUpload } from './upload-view.js';

const removed: string[] = [];
const files: DocumentUploadFilesPort = {
  offset: () => Promise.resolve(0),
  append: () => Promise.resolve(0),
  sha256: () => Promise.resolve(''),
  find: () => Promise.resolve(null),
  remove: (id) => {
    removed.push(id);
    return Promise.resolve();
  },
};

const record = (
  fields: Partial<DocumentUploadRecord> = {},
): DocumentUploadRecord => ({
  id: '11111111-1111-4111-8111-111111111111',
  topic: 'hermetismo',
  kind: 'url',
  name: 'https://example.org/a',
  url: 'https://example.org/a',
  sha256: null,
  bytes: null,
  level: null,
  owner: {
    principal: 'sub-ana',
    email: 'ana@example.com',
    isMaster: false,
    quotaBytes: null,
    displayName: 'Ana',
  },
  state: 'received',
  failure: null,
  detail: null,
  document: null,
  mediaId: null,
  lease: null,
  batch: null,
  attempts: 0,
  spentUsd: 0,
  entries: [],
  createdAt: '2026-11-16T10:00:00.000Z',
  updatedAt: '2026-11-16T10:00:00.000Z',
  ...fields,
});

const NOT_HELD = { batch: null, heldBy: null, kept: false } as const;
const BATCH = { id: '99999999-9999-4999-8999-999999999999', capUsd: 0.05 };
const SECOND = '22222222-2222-4222-8222-222222222222';

async function queueWith(
  records: DocumentUploadRecord[],
  options: { budget?: number; clock: { now: Date } },
) {
  const store = new MemoryDocumentUploadStore();
  store.records = records;
  const opened = await UploadRecords.open(store);
  const queue = new DocIngestQueue({
    records: opened,
    files,
    budgetUsd: () => options.budget ?? 0.5,
    now: () => options.clock.now,
  });
  return { queue, store, opened };
}

describe('DocIngestQueue (KBC-149, ADR 0040)', () => {
  it('leases the oldest first, and a lease that expired is leased again as a new attempt', async () => {
    const clock = { now: new Date('2026-11-16T12:00:00.000Z') };
    const newer = record({
      id: '22222222-2222-4222-8222-222222222222',
      createdAt: '2026-11-16T11:00:00.000Z',
    });
    const { queue } = await queueWith([newer, record()], { clock });

    const first = queue.lease('mac');
    expect(first?.id).toBe(record().id);
    expect(first?.attempt).toBe(1);
    expect(queue.isHeldBy('mac')).toBe(true);
    expect(queue.leasableJobs()).toBe(1);
    expect(queue.lease('mac')?.id).toBe(newer.id);
    expect(queue.lease('mac')).toBeNull();

    clock.now = new Date(clock.now.getTime() + DOC_INGEST_LEASE_MS + 1);
    expect(queue.isHeldBy('mac')).toBe(false);
    const again = queue.lease('other');
    expect(again?.id).toBe(record().id);
    expect(again?.attempt).toBe(2);
    expect(() =>
      queue.heartbeat({
        jobId: record().id,
        worker: 'mac',
        leaseId: first?.leaseId ?? '',
      }),
    ).toThrow(/no longer yours/);
  });

  it('gives up a document whose leases kept expiring', async () => {
    const clock = { now: new Date('2026-11-16T12:00:00.000Z') };
    const { queue, opened } = await queueWith(
      [
        record({
          state: 'converting',
          attempts: 2,
          lease: {
            leaseId: 'x',
            worker: 'mac',
            until: '2026-11-16T11:00:00.000Z',
            budgetUsd: 0.5,
          },
        }),
      ],
      { clock },
    );

    expect(queue.lease('mac')).toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(opened.get(record().id)).toMatchObject({
      state: 'failed',
      failure: 'gave-up',
    });
    // Its file stays: the person may send it again as it is.
    expect(removed).not.toContain(record().id);
  });

  it('gives nothing out with the media month spent', async () => {
    const clock = { now: new Date() };
    const { queue } = await queueWith([record()], { clock, budget: 0 });
    expect(queue.leasableJobs()).toBe(0);
    expect(queue.lease('mac')).toBeNull();
  });

  it('a setup failure waits without spending an attempt', async () => {
    const clock = { now: new Date('2026-11-16T12:00:00.000Z') };
    const { queue, opened } = await queueWith([record()], { clock });
    const job = queue.lease('mac');
    await queue.fail(
      { jobId: record().id, worker: 'mac', leaseId: job?.leaseId ?? '' },
      { detail: 'no kb key', configuration: true },
    );
    expect(opened.get(record().id)).toMatchObject({
      state: 'received',
      attempts: 0,
    });
  });
});

describe('the ceiling of one inclusion (KBC-009 R3)', () => {
  const clock = { now: new Date('2026-11-25T12:00:00.000Z') };

  it('a job may spend what is left of the month or of its inclusion, the smaller', async () => {
    const { queue } = await queueWith(
      [record({ batch: { ...BATCH, capUsd: 0.3 }, spentUsd: 0.1 })],
      { clock, budget: 0.5 },
    );
    expect(queue.lease('mac')?.budgetUsd).toBeCloseTo(0.2);
  });

  it('what another item of the inclusion holds on the Mac is not given out twice', async () => {
    const { queue } = await queueWith(
      [record({ batch: BATCH }), record({ id: SECOND, batch: BATCH })],
      { clock },
    );
    expect(queue.lease('mac')?.budgetUsd).toBeCloseTo(0.05);
    expect(queue.leasableJobs()).toBe(0);
    expect(queue.lease('mac')).toBeNull();
  });

  it('a spent inclusion waits, while another inclusion goes on', async () => {
    const other = { id: '88888888-8888-4888-8888-888888888888', capUsd: 0.5 };
    const { queue } = await queueWith(
      [
        record({ batch: BATCH, state: 'mapped', spentUsd: 0.05 }),
        record({
          id: SECOND,
          batch: BATCH,
          createdAt: '2026-11-16T10:01:00.000Z',
        }),
        record({
          id: '33333333-3333-4333-8333-333333333333',
          batch: other,
          createdAt: '2026-11-16T10:02:00.000Z',
        }),
      ],
      { clock },
    );
    expect(queue.leasableJobs()).toBe(1);
    expect(queue.lease('mac')?.id).toBe('33333333-3333-4333-8333-333333333333');
  });

  it('what a failed attempt spent counts against the ceiling', async () => {
    const { queue, opened } = await queueWith([record({ batch: BATCH })], {
      clock,
    });
    const job = queue.lease('mac');
    await queue.fail(
      { jobId: record().id, worker: 'mac', leaseId: job?.leaseId ?? '' },
      { detail: 'kb link: 502', spendUsd: 0.02 },
    );
    expect(opened.get(record().id)?.spentUsd).toBeCloseTo(0.02);
    expect(queue.lease('mac')?.budgetUsd).toBeCloseTo(0.03);
  });

  it('an upload from before inclusions keeps the month as its only ceiling', async () => {
    const { queue } = await queueWith([record()], { clock, budget: 0.4 });
    expect(queue.lease('mac')?.budgetUsd).toBe(0.4);
  });

  it('says a document was written only when a new one was', async () => {
    const written: string[] = [];
    const store = new MemoryDocumentUploadStore();
    store.records = [record(), record({ id: SECOND })];
    const queue = new DocIngestQueue({
      records: await UploadRecords.open(store),
      files,
      budgetUsd: () => 0.5,
      written: (topic) => written.push(topic),
      now: () => clock.now,
    });
    for (const state of ['ready', 'duplicate'] as const) {
      const job = queue.lease('mac');
      await queue.complete(
        { jobId: job?.id ?? '', worker: 'mac', leaseId: job?.leaseId ?? '' },
        {
          worker: 'mac',
          leaseId: job?.leaseId ?? '',
          outcome: { state, document: { id: 'raw/a.md', title: 'A' } },
          spendUsd: 0,
        },
      );
    }
    expect(written).toEqual(['hermetismo']);
  });
});

describe('the upload as people see it', () => {
  it('shows the Mac\'s words to masters only, and "pronto" once the document arrived', () => {
    const done = record({
      state: 'mapped',
      detail: 'kb: ok',
      document: { id: 'raw/a.md', title: 'A' },
    });
    expect(
      toDocumentUpload(done, {
        showsDetail: false,
        received: null,
        media: null,
        arrived: false,
        ...NOT_HELD,
      }),
    ).toMatchObject({ state: 'mapped', detail: null, uploadUrl: null });
    expect(
      toDocumentUpload(done, {
        showsDetail: true,
        received: null,
        media: null,
        arrived: true,
        ...NOT_HELD,
      }),
    ).toMatchObject({ state: 'ready', detail: 'kb: ok' });
    const recording = record({
      kind: 'recording',
      state: 'transcribing',
      mediaId: done.id,
    });
    expect(
      toDocumentUpload(recording, {
        showsDetail: false,
        received: null,
        media: 'failed',
        arrived: false,
        ...NOT_HELD,
      }),
    ).toMatchObject({ state: 'failed', failure: 'conversion-failed' });
  });
});
