import type { DocIngestJob } from '@kb-chat/contracts';
import { describe, expect, it, vi } from 'vitest';
import {
  DOCUMENTS_IN_A_ROW,
  WorkerService,
  type WorkerServiceDeps,
} from './worker-service.js';

const document = { kind: 'doc-ingest', id: 'd' } as DocIngestJob;

/** A queue with documents and a recording waiting, and whether the worker holds a lease. */
function service(options: { documents: number; holds?: boolean }) {
  let left = options.documents;
  const recording = { id: 'm', leaseId: 'l', mediaId: 'x', attempt: 1 };
  const leaseJob = vi.fn(() => ({ ...recording, kind: 'transcode' }));
  const deps = {
    store: {
      leaseJob,
      holdsLease: () => options.holds === true,
      getMedia: () => null,
    },
    docs: {
      lease: () => (left-- > 0 ? document : null),
      isHeldBy: () => false,
      isJob: () => false,
    },
    files: { sourcePath: () => '/x' },
  } as unknown as WorkerServiceDeps;
  return { service: new WorkerService(deps), leaseJob };
}

const lease = (one: WorkerService, worker = 'mac') => {
  try {
    const kinds = ['transcode', 'doc-ingest'] as const;
    return one.lease({ worker, kinds: [...kinds], oneAtATime: true })?.kind;
  } catch {
    // The stub has no file for the recording: that it was its turn is what is looked at.
    return 'recording';
  }
};

describe('WorkerService: what goes first (KBC-184)', () => {
  it('documents, a few in a row, then a recording has its turn', () => {
    const { service: one, leaseJob } = service({ documents: 100 });
    for (let n = 0; n < DOCUMENTS_IN_A_ROW; n += 1)
      expect(lease(one)).toBe('doc-ingest');
    expect(leaseJob).not.toHaveBeenCalled();
    expect(lease(one)).not.toBe('doc-ingest');
    expect(leaseJob).toHaveBeenCalledOnce();
    expect(lease(one)).toBe('doc-ingest');
  });

  it('each worker has its own turns, and none is given one while it holds a lease', () => {
    const { service: one } = service({ documents: 100 });
    for (let n = 0; n < DOCUMENTS_IN_A_ROW; n += 1) lease(one);
    expect(lease(one, 'other')).toBe('doc-ingest');
    const held = service({ documents: 1, holds: true });
    expect(lease(held.service)).not.toBe('doc-ingest');
  });

  it('with no document waiting a recording goes at once', () => {
    const { service: one, leaseJob } = service({ documents: 0 });
    expect(lease(one)).not.toBe('doc-ingest');
    expect(leaseJob).toHaveBeenCalledOnce();
  });
});
