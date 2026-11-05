import type { PreparationStage } from '@kb-chat/contracts';
import { describe, expect, it } from 'vitest';
import {
  activeCountOf,
  impliedPlan,
  inQueueOrder,
  isGhost,
  positionsOf,
  queueItemOf,
} from './processing-queue.js';

const stage = (
  id: PreparationStage['stage'],
  state: PreparationStage['state'],
  over: Partial<PreparationStage> = {},
): PreparationStage => ({
  stage: id,
  state,
  percent: null,
  cuts: null,
  ahead: null,
  blockedBy: null,
  failure: null,
  canRetry: false,
  windows: null,
  reservedUsd: null,
  spentUsd: null,
  estimateUsd: null,
  ...over,
});

const facts = (over: Partial<Parameters<typeof queueItemOf>[0]> = {}) => ({
  item: { id: 'a', title: 'Áudio', topic: 'udv' },
  stages: [stage('convert', 'done'), stage('transcribe', 'running')],
  next: null,
  position: null,
  step: 2 as const,
  canEdit: true,
  transcriberOn: () => true,
  ...over,
});

const aTranscription = {
  status: 'none' as const,
  confidence: null,
  version: null,
  transcriber: 'on' as const,
  transcriberOffSince: null,
  lastAttemptFailed: false,
};

describe('positionsOf (KBC-090)', () => {
  it('counts each worker line apart, and transcription and voices as one', () => {
    const positions = positionsOf([
      { mediaId: 'running', kind: 'transcribe', status: 'leased' },
      { mediaId: 'a', kind: 'transcribe', status: 'queued' },
      { mediaId: 'b', kind: 'transcode', status: 'queued' },
      { mediaId: 'c', kind: 'diarize', status: 'queued' },
    ]);
    expect(positions.get('running')).toBeUndefined();
    expect(positions.get('a')).toBe(1);
    expect(positions.get('b')).toBe(1);
    expect(positions.get('c')).toBe(2);
  });

  it('keeps an audio at its first place', () => {
    const positions = positionsOf([
      { mediaId: 'a', kind: 'transcribe', status: 'queued' },
      { mediaId: 'a', kind: 'diarize', status: 'queued' },
    ]);
    expect(positions.get('a')).toBe(1);
  });
});

describe('queueItemOf (KBC-090)', () => {
  it('takes the first stage not done and says the one after it', () => {
    const item = queueItemOf(
      facts({
        stages: [
          stage('convert', 'done'),
          stage('transcribe', 'running', {
            percent: 35,
            cuts: { done: 14, total: 40 },
          }),
          stage('speakers', 'waiting'),
        ],
      }),
    );
    expect(item).toMatchObject({
      phase: 'running',
      stage: 'transcribe',
      percent: 35,
      cuts: { done: 14, total: 40 },
      nextStage: 'speakers',
      action: null,
    });
  });

  it('gives a place only to what is in a line', () => {
    const running = queueItemOf(facts({ position: 3 }));
    expect(running.position).toBeNull();
    const queued = queueItemOf(
      facts({ position: 3, stages: [stage('transcribe', 'queued')] }),
    );
    expect(queued).toMatchObject({ phase: 'next', position: 3 });
  });

  it('says the transcriber is why a stage waits, and only then', () => {
    const queued = [stage('speakers', 'queued')];
    const off = facts({ stages: queued, transcriberOn: () => false });
    expect(queueItemOf(off).waitsForTranscriber).toBe(true);
    expect(queueItemOf(facts({ stages: queued })).waitsForTranscriber).toBe(
      false,
    );
    const converting = { ...off, stages: [stage('convert', 'queued')] };
    expect(queueItemOf(converting).waitsForTranscriber).toBe(false);
  });

  it('retries a failed stage where it is', () => {
    const failed = stage('speakers', 'failed', {
      canRetry: true,
      failure: 'work',
    });
    const item = queueItemOf(facts({ stages: [failed] }));
    expect(item).toMatchObject({
      phase: 'attention',
      action: 'retry',
      retryStage: 'speakers',
      failure: 'work',
    });
  });

  it('sends a recording with no plan to its page to retry', () => {
    const failed = stage('transcribe', 'failed', { canRetry: true });
    const item = queueItemOf(facts({ stages: [failed], step: null }));
    expect(item).toMatchObject({ action: 'retry', retryStage: null });
  });

  it('leads to the plan what cannot be retried by a click', () => {
    const failed = stage('tracks', 'failed', { failure: 'monthly-cap' });
    expect(queueItemOf(facts({ stages: [failed] })).action).toBe('continue');
  });

  it('offers the press that moves on, once nothing runs', () => {
    const done = [stage('convert', 'done')];
    const item = queueItemOf(facts({ stages: done, next: 'validate' }));
    expect(item).toMatchObject({
      phase: 'attention',
      stage: null,
      nextStage: null,
      action: 'validate',
    });
  });

  it('continues on step 3, and what is blocked leads to the plan', () => {
    const done = [stage('convert', 'done')];
    expect(queueItemOf(facts({ stages: done, step: 3 })).action).toBe(
      'continue',
    );
    const blocked = [stage('tracks', 'blocked')];
    expect(queueItemOf(facts({ stages: blocked })).action).toBe('continue');
  });

  it('offers nothing to who cannot edit, and does not ask them', () => {
    const failed = stage('speakers', 'failed', { canRetry: true });
    const item = queueItemOf(facts({ stages: [failed], canEdit: false }));
    expect(item).toMatchObject({
      action: null,
      retryStage: null,
      phase: 'stopped',
    });
  });

  it('retries a stage that failed on step 3', () => {
    const failed = stage('speakers', 'failed', { canRetry: true });
    const item = queueItemOf(facts({ stages: [failed], step: 3 }));
    expect(item).toMatchObject({ action: 'retry', retryStage: 'speakers' });
  });

  it('calls a line with nothing to say or do a ghost', () => {
    const done = queueItemOf(
      facts({ stages: [stage('convert', 'done')], step: null }),
    );
    expect(isGhost(done)).toBe(true);
    expect(isGhost(queueItemOf(facts()))).toBe(false);
  });
});

describe('the queue as a whole (KBC-090)', () => {
  const running = queueItemOf(facts({ item: { ...facts().item, id: 'r' } }));
  const second = queueItemOf(
    facts({
      item: { ...facts().item, id: 's' },
      stages: [stage('transcribe', 'queued')],
      position: 2,
    }),
  );
  const first = { ...second, mediaId: 'f', position: 1 };
  const stopped = queueItemOf(
    facts({
      item: { ...facts().item, id: 'x' },
      stages: [stage('speakers', 'failed')],
    }),
  );

  it('goes from what runs to the line to what waits for a person', () => {
    const ordered = inQueueOrder([stopped, second, first, running]);
    expect(ordered.map((one) => one.mediaId)).toEqual(['r', 'f', 's', 'x']);
  });

  it('counts only what is at work or in line', () => {
    expect(activeCountOf([stopped, second, running])).toBe(2);
  });

  it('reads an audio with no plan by what is happening to it', () => {
    const transcription = (status: 'none' | 'waiting') => ({
      transcription: { ...aTranscription, status },
    });
    expect(impliedPlan(transcription('none'), true)).toMatchObject({
      transcribe: false,
      speakers: true,
      tracks: 'none',
    });
    expect(impliedPlan(transcription('waiting'), false).transcribe).toBe(true);
  });
});
