import type { PreparationPlan, ProposalRun } from '@kb-chat/contracts';
import { describe, expect, it } from 'vitest';
import {
  nextActionOf,
  stagesOf,
  type StageFacts,
} from './preparation-stages.js';

const PLAN: PreparationPlan = {
  transcribe: true,
  speakers: true,
  tracks: 'ai',
  subjects: false,
  acceptedUsd: 0.02,
};

const transcription = (
  status: 'none' | 'waiting' | 'transcribing' | 'done' | 'failed',
) => ({
  status,
  confidence: null,
  version: status === 'done' ? 1 : null,
  transcriber: 'on' as const,
  transcriberOffSince: null,
});

const facts = (over: Partial<StageFacts> = {}): StageFacts => ({
  plan: PLAN,
  item: {
    status: 'ready',
    progress: null,
    failure: null,
    canRetry: false,
    transcription: transcription('done'),
  },
  separation: 'done',
  hasVoices: true,
  claimed: false,
  starting: false,
  stop: null,
  stopUsd: null,
  run: null,
  runFailure: null,
  cuts: null,
  ahead: { transcribe: 0, speakers: 0 },
  canPropose: true,
  ...over,
});

const run = (over: Partial<ProposalRun>): ProposalRun => ({
  id: '11111111-1111-4111-8111-111111111111',
  mediaId: '22222222-2222-4222-8222-222222222222',
  status: 'running',
  model: 'stub',
  windowsTotal: 4,
  windowsDone: 1,
  tracks: 3,
  estimateUsd: 0.02,
  spentUsd: 0.005,
  failure: null,
  createdAt: '2026-11-04T05:00:00.000Z',
  finishedAt: null,
  ...over,
});

const stateOf = (stages: ReturnType<typeof stagesOf>, id: string) =>
  stages.find(({ stage }) => stage === id);

describe('stages of a plan (KBC-072 FR-2)', () => {
  it('leaves out what nobody asked for', () => {
    const stages = stagesOf(
      facts({
        plan: { ...PLAN, speakers: false, tracks: 'none', acceptedUsd: null },
      }),
    );
    expect(stages.map(({ stage }) => stage)).toEqual([
      'upload',
      'convert',
      'transcribe',
    ]);
  });

  it('shows the cuts and the percent while transcribing', () => {
    const stages = stagesOf(
      facts({
        item: { ...facts().item, transcription: transcription('transcribing') },
        separation: 'none',
        cuts: { done: 14, total: 40 },
      }),
    );
    expect(stateOf(stages, 'transcribe')).toMatchObject({
      state: 'running',
      percent: 35,
      cuts: { done: 14, total: 40 },
    });
    expect(stateOf(stages, 'speakers')?.state).toBe('waiting');
    expect(stateOf(stages, 'tracks')?.state).toBe('waiting');
  });

  it('has no percent with a transcriber too old to send the cuts (FR-3)', () => {
    const stages = stagesOf(
      facts({
        item: { ...facts().item, transcription: transcription('transcribing') },
      }),
    );
    expect(stateOf(stages, 'transcribe')).toMatchObject({
      state: 'running',
      percent: null,
      cuts: null,
    });
  });

  it('blocks what depends on a stage that failed, naming it (BR-6)', () => {
    const stages = stagesOf(
      facts({
        item: { ...facts().item, transcription: transcription('failed') },
        separation: 'none',
      }),
    );
    expect(stateOf(stages, 'transcribe')).toMatchObject({
      state: 'failed',
      canRetry: true,
    });
    expect(stateOf(stages, 'speakers')).toMatchObject({
      state: 'blocked',
      blockedBy: 'transcribe',
    });
    expect(stateOf(stages, 'tracks')).toMatchObject({
      state: 'blocked',
      blockedBy: 'transcribe',
    });
  });

  it('follows the windows of the run, with the money reserved and spent', () => {
    const stages = stagesOf(facts({ claimed: true, run: run({}) }));
    expect(stateOf(stages, 'tracks')).toMatchObject({
      state: 'running',
      percent: 25,
      windows: { done: 1, total: 4 },
      reservedUsd: 0.02,
      spentUsd: 0.005,
    });
  });

  it('offers no retry when only money or a permission gets past it', () => {
    const capped = stagesOf(facts({ claimed: true, stop: 'monthly-cap' }));
    expect(stateOf(capped, 'tracks')).toMatchObject({
      state: 'failed',
      failure: 'monthly-cap',
      canRetry: false,
    });
  });

  it('says the new value when the estimate rose, and a click may pay it', () => {
    const rose = stagesOf(
      facts({ claimed: true, stop: 'estimate-rose', stopUsd: 0.05 }),
    );
    expect(stateOf(rose, 'tracks')).toMatchObject({
      failure: 'estimate-rose',
      canRetry: true,
      estimateUsd: 0.05,
    });
  });

  it('never offers a paid retry to who may not propose', () => {
    const stages = stagesOf(
      facts({ claimed: true, runFailure: 'provider', canPropose: false }),
    );
    expect(stateOf(stages, 'tracks')).toMatchObject({
      state: 'failed',
      canRetry: false,
    });
  });

  it('reads a taken stage with no run as interrupted, not as running', () => {
    const stages = stagesOf(facts({ claimed: true }));
    expect(stateOf(stages, 'tracks')).toMatchObject({
      state: 'failed',
      failure: 'interrupted',
    });
  });

  it('counts the conversion that failed, and only a master retries it', () => {
    const stages = stagesOf(
      facts({
        item: {
          ...facts().item,
          status: 'failed',
          failure: 'conversion-failed',
          canRetry: true,
          transcription: transcription('none'),
        },
      }),
    );
    expect(stateOf(stages, 'convert')).toMatchObject({
      state: 'failed',
      canRetry: true,
    });
    expect(stateOf(stages, 'transcribe')).toMatchObject({
      state: 'blocked',
      blockedBy: 'convert',
    });
  });
});

describe('the action once processed (BR-5)', () => {
  it('waits while anything runs', () => {
    const stages = stagesOf(facts({ claimed: true, run: run({}) }));
    expect(nextActionOf(PLAN, stages)).toBeNull();
  });

  it('is "Validar faixas" with the proposal done', () => {
    const stages = stagesOf(
      facts({ claimed: true, run: run({ status: 'done' }) }),
    );
    expect(nextActionOf(PLAN, stages)).toBe('validate');
  });

  it('is "Concluir" when the person chose not to divide', () => {
    const plan = { ...PLAN, tracks: 'none' as const, acceptedUsd: null };
    expect(nextActionOf(plan, stagesOf(facts({ plan })))).toBe('conclude');
  });

  it('stops on an AI that failed until the person switches to marking', () => {
    const stages = stagesOf(facts({ claimed: true, runFailure: 'provider' }));
    expect(nextActionOf(PLAN, stages)).toBeNull();
    const plan = { ...PLAN, tracks: 'manual' as const };
    expect(nextActionOf(plan, stagesOf(facts({ plan })))).toBe('validate');
  });

  it('lets a person mark by hand even when the voices failed', () => {
    const plan = { ...PLAN, tracks: 'manual' as const };
    const stages = stagesOf(facts({ plan, separation: 'failed' }));
    expect(nextActionOf(plan, stages)).toBe('validate');
  });
});
