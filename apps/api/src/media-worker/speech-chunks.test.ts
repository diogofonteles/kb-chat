import { describe, expect, it } from 'vitest';
import { mergeChunks, planChunks } from './speech-chunks.js';

describe('planChunks (KBC-037 FR-3): where a track is cut for Groq', () => {
  it('cuts speech at its pauses, padded by 300 ms, into chunks of at most 28 s', () => {
    const plan = planChunks({
      durationMs: 60_000,
      silences: [
        { startMs: 20_000, endMs: 22_000 },
        { startMs: 40_000, endMs: 41_500 },
      ],
    });
    expect(plan.vad).toBe('applied');
    expect(plan.chunks).toEqual([
      { startMs: 0, endMs: 20_300 },
      { startMs: 21_700, endMs: 40_300 },
      { startMs: 41_200, endMs: 60_000 },
    ]);
    for (const chunk of plan.chunks)
      expect(chunk.endMs - chunk.startMs).toBeLessThanOrEqual(28_000);
    expect(plan.speechRatio).toBeGreaterThan(0.9);
  });

  it('drops a sliver of sound under 250 ms between two pauses', () => {
    const plan = planChunks({
      durationMs: 10_000,
      silences: [
        { startMs: 2_000, endMs: 5_000 },
        { startMs: 5_200, endMs: 6_000 },
      ],
    });
    expect(plan.chunks).toEqual([{ startMs: 0, endMs: 10_000 }]);
  });

  it('splits one long stretch of speech into 28 s pieces', () => {
    const plan = planChunks({ durationMs: 70_000, silences: [] });
    expect(plan.chunks).toEqual([
      { startMs: 0, endMs: 28_000 },
      { startMs: 28_000, endMs: 56_000 },
      { startMs: 56_000, endMs: 70_000 },
    ]);
  });

  it('goes in fixed 28 s windows over the whole track when speech is under 40 %', () => {
    const plan = planChunks({
      durationMs: 60_000,
      silences: [{ startMs: 5_000, endMs: 60_000 }],
    });
    expect(plan.vad).toBe('skipped');
    expect(plan.speechRatio).toBeLessThan(0.4);
    expect(plan.chunks).toEqual([
      { startMs: 0, endMs: 28_000 },
      { startMs: 28_000, endMs: 56_000 },
      { startMs: 56_000, endMs: 60_000 },
    ]);
  });

  it('has nothing to cut in an empty track', () => {
    expect(planChunks({ durationMs: 0, silences: [] })).toEqual({
      chunks: [],
      vad: 'skipped',
      speechRatio: 0,
    });
  });
});

describe('mergeChunks', () => {
  it('joins short spans while the chunk stays within 28 s, like the Mac', () => {
    expect(
      mergeChunks([
        { startMs: 0, endMs: 5_000 },
        { startMs: 6_000, endMs: 20_000 },
        { startMs: 21_000, endMs: 30_000 },
      ]),
    ).toEqual([
      { startMs: 0, endMs: 20_000 },
      { startMs: 21_000, endMs: 30_000 },
    ]);
  });
});
