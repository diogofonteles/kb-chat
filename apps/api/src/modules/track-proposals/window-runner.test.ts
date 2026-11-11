import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  StubLlm,
  evenSegments,
  proposalDb,
  wholeWindow,
  type StubReply,
} from '../../../test/track-proposal-fixtures.js';
import type { LlmPrice } from '../../ports/llm.js';
import { buildPlan } from './proposal-plan.js';
import { WindowRunner } from './window-runner.js';
import { toPromptSegments } from './windows.js';

/** One window's run, its single call's worst case exactly `outputUsd` (no input price). */
function oneWindow(input: {
  readonly outputUsd: number;
  readonly acceptedUsd: number;
  readonly replies: StubReply[];
  readonly runCapUsd?: number;
  readonly carriedUsd?: number;
}) {
  const db = proposalDb(evenSegments(30));
  const price: LlmPrice = { input: 0, output: input.outputUsd / 3_000 };
  const llm = new StubLlm(input.replies, price);
  llm.costPerCall = input.outputUsd;
  const plan = buildPlan({
    mediaId: db.mediaId,
    transcriptId: db.transcriptId,
    segments: toPromptSegments(db.transcripts.segments(db.transcriptId), null),
    context: {
      collection: 'Hermetismo',
      knownNames: [],
      title: 'Palestra',
      author: null,
      terms: [],
    },
    model: { id: llm.model, price },
  });
  const runId = randomUUID();
  db.store.startRun({
    id: runId,
    mediaId: db.mediaId,
    transcriptId: db.transcriptId,
    principal: 'owner',
    model: llm.model,
    spendId: 'spend-1',
    windowsTotal: plan.windows.length,
    estimateUsd: plan.estimateUsd,
    limitUsd: input.acceptedUsd,
    now: new Date(),
    carriedUsd: input.carriedUsd ?? 0,
    resumes: null,
  });
  const runner = new WindowRunner({
    runId,
    plan,
    llm,
    store: db.store,
    runCapUsd: input.runCapUsd ?? 0.25,
    carriedUsd: input.carriedUsd ?? 0,
    acceptedUsd: input.acceptedUsd,
    signal: new AbortController().signal,
  });
  return { runner, llm, store: db.store, runId };
}

describe('WindowRunner: the value accepted (KBC-112)', () => {
  it('makes the call that reaches the value exactly (AC-9)', async () => {
    const { runner, llm } = oneWindow({
      outputUsd: 0.0234,
      acceptedUsd: 0.0234,
      replies: [wholeWindow()],
    });
    expect(await runner.run()).toEqual({ failure: null, spentUsd: 0.0234 });
    expect(llm.calls).toHaveLength(1);
  });

  it('does not make a call that could pass it by a fraction of a cent (AC-9)', async () => {
    const { runner, llm } = oneWindow({
      outputUsd: 0.02340001,
      acceptedUsd: 0.0234,
      replies: [wholeWindow()],
    });
    expect(await runner.run()).toMatchObject({
      failure: 'accepted-limit',
      spentUsd: 0,
    });
    expect(llm.calls).toHaveLength(0);
  });

  it('counts the window asked again: it stops there, not in invalid-output (AC-1, AC-2)', async () => {
    const { runner, llm } = oneWindow({
      outputUsd: 0.01,
      acceptedUsd: 0.015,
      replies: ['ilegível', wholeWindow()],
    });
    expect(await runner.run()).toMatchObject({
      failure: 'accepted-limit',
      spentUsd: 0.01,
    });
    expect(llm.calls).toHaveLength(1);
  });

  it('meets the run cap when what it has left is less than the value (AC-4)', async () => {
    const { runner, llm } = oneWindow({
      outputUsd: 0.01,
      acceptedUsd: 0.02,
      runCapUsd: 0.25,
      carriedUsd: 0.245,
      replies: [wholeWindow()],
    });
    expect(await runner.run()).toMatchObject({ failure: 'run-cap' });
    expect(llm.calls).toHaveLength(0);
  });

  it('records a window billed past its worst case at the cap left, not at the value (FR-7)', async () => {
    const { runner, llm, store, runId } = oneWindow({
      outputUsd: 0.01,
      acceptedUsd: 0.04,
      runCapUsd: 0.25,
      carriedUsd: 0.23,
      replies: [wholeWindow()],
    });
    llm.costPerCall = 0.05;
    expect(await runner.run()).toEqual({ failure: null, spentUsd: 0.05 });
    // The run's row counts the carried spend too: 0.23 + 0.02, the run cap.
    expect(store.getRun(runId)?.spentUsd).toBeCloseTo(0.25, 12);
  });

  it('does not count what earlier attempts spent against the value (BR-4)', async () => {
    const { runner } = oneWindow({
      outputUsd: 0.01,
      acceptedUsd: 0.01,
      runCapUsd: 0.25,
      carriedUsd: 0.2,
      replies: [wholeWindow()],
    });
    expect(await runner.run()).toEqual({ failure: null, spentUsd: 0.01 });
  });
});
