import type { Transcriber, TranscriberStatusReport } from '@kb-chat/contracts';
import { describe, expect, it } from 'vitest';
import { TranscriberStatusBoard } from './transcriber-status.js';

const MAC: Transcriber = {
  id: '33333333-3333-4333-8333-333333333333',
  name: 'Mac do dono',
  kinds: ['transcribe', 'kb-publish'],
  createdAt: '2026-11-09T11:00:00.000Z',
  lastSeenAt: '2026-11-09T12:00:00.000Z',
  online: true,
  currentJob: {
    mediaId: '44444444-4444-4444-8444-444444444444',
    title: 'Aula 3',
    kind: 'transcribe',
  },
};

const working: TranscriberStatusReport = {
  state: 'working',
  detail: null,
  version: '0.1.0',
  kinds: ['transcribe'],
  startedAt: '2026-11-09T12:00:00.000Z',
  currentJob: {
    id: '11111111-1111-4111-8111-111111111111',
    kind: 'transcribe',
    // The lease carries no title: the worker names the job by its media.
    label: '44444444-4444-4444-8444-444444444444',
    startedAt: '2026-11-09T12:00:00.000Z',
    progress: 10,
  },
  recentJobs: [],
  lastError: null,
  counts: { done: 0, failed: 0 },
  vaultPath: null,
  kbVersion: null,
};

const boardOf = (transcriber: Transcriber) =>
  new TranscriberStatusBoard({
    transcribers: { list: () => [transcriber] },
    kbWaiting: () => 3,
    canStartHere: false,
    now: () => new Date('2026-11-09T12:00:30.000Z'),
  });

describe('TranscriberStatusBoard (KBC-114 FR-8)', () => {
  it("names the job by the item's title the API knows it holds", () => {
    const board = boardOf(MAC);
    board.record(MAC.id, working);
    const [item] = board.overview().items;
    expect(item?.report?.currentJob?.label).toBe('Aula 3');
    expect(board.overview().kbQueue).toEqual({ waiting: 3 });
  });

  it("keeps the worker's own label for a job of another kind", () => {
    const board = boardOf({ ...MAC, currentJob: null });
    const publishing = {
      ...working,
      currentJob: {
        ...working.currentJob,
        kind: 'kb-publish' as const,
        label: 'publicando udv (3 documentos)',
        id: '55555555-5555-4555-8555-555555555555',
        startedAt: working.startedAt,
        progress: null,
      },
    };
    board.record(MAC.id, publishing);
    expect(board.overview().items[0]?.report?.currentJob?.label).toBe(
      'publicando udv (3 documentos)',
    );
  });
});
