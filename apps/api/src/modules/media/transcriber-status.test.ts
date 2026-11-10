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

describe('A transcriber that exits when idle (KBC-114 AC-18)', () => {
  it('is off as soon as it says it stopped, though it was seen a moment ago', () => {
    const board = boardOf({ ...MAC, currentJob: null });
    board.record(MAC.id, { ...working, state: 'stopped', currentJob: null });
    expect(board.overview().items[0]?.state).toBe('offline');
    expect(board.anyOnline()).toBe(false);
  });

  it('is on while it works', () => {
    const board = boardOf(MAC);
    board.record(MAC.id, working);
    expect(board.anyOnline()).toBe(true);
  });
});

describe('Why a kind waits (review r2 N-1, S-2)', () => {
  it('N-1: a report still preparing, with no kinds yet, is unknown, never "does nothing"', () => {
    const board = boardOf({ ...MAC, currentJob: null });
    // What `cli.run` sends before the models load: kinds are not known yet.
    board.record(MAC.id, {
      ...working,
      state: 'waiting',
      kinds: [],
      currentJob: null,
    });
    expect(board.whyNot('transcribe')).toBeNull();
    expect(board.whyNot('kb-publish')).toBeNull();
  });

  it('S-2: marked but not loaded on the Mac is "not installed", not "not marked"', () => {
    const board = boardOf({
      ...MAC,
      kinds: ['transcribe', 'diarize'],
      currentJob: null,
    });
    board.record(MAC.id, { ...working, kinds: ['transcribe'] });
    expect(board.whyNot('diarize')).toBe('not-installed');
    expect(board.whyNot('voice-profile')).toBe('not-marked');
    expect(board.whyNot('transcribe')).toBeNull();
  });

  it('S-2: with no transcriber paired, the reason is that one', () => {
    const board = new TranscriberStatusBoard({
      transcribers: { list: () => [] },
      kbWaiting: () => 0,
      canStartHere: true,
    });
    expect(board.whyNot('transcribe')).toBe('none-paired');
  });
});

describe('TranscriberStatusBoard: the Mac publishes again (KBC-117)', () => {
  const ready = {
    ...working,
    kinds: ['transcribe' as const, 'kb-publish' as const],
  };
  const preparing = { ...working, state: 'waiting' as const, kinds: [] };
  const missing = {
    ...working,
    kinds: ['transcribe' as const],
    unavailable: [
      {
        kind: 'kb-publish' as const,
        reason: 'kb-ai-key-missing' as const,
        detail: 'chave da IA do kb ausente',
      },
    ],
  };

  const counted = () => {
    const calls: string[] = [];
    const board = new TranscriberStatusBoard({
      transcribers: { list: () => [MAC] },
      kbWaiting: () => 0,
      canStartHere: false,
      onKbReady: () => calls.push('ready'),
    });
    return { board, calls };
  };

  it('fires once when it starts publishing, not at each report', () => {
    const { board, calls } = counted();
    board.record(MAC.id, missing);
    board.record(MAC.id, missing);
    expect(calls).toEqual([]);
    board.record(MAC.id, ready);
    board.record(MAC.id, ready);
    expect(calls).toEqual(['ready']);
  });

  it('QA F-2: a restart of the Mac (preparing, no kinds yet) is not a new start of publishing', () => {
    const { board, calls } = counted();
    board.record(MAC.id, ready);
    board.record(MAC.id, preparing);
    board.record(MAC.id, ready);
    expect(calls).toEqual(['ready']);
  });

  it('names what the Mac said it lacks', () => {
    const { board } = counted();
    board.record(MAC.id, missing);
    expect(board.whyNot('kb-publish')).toBe('kb-ai-key-missing');
  });
});
