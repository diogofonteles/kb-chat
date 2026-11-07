import { describe, expect, it } from 'vitest';
import { stageFailureSchema } from './media-preparation.js';
import {
  acceptedLimitStopSchema,
  draftTrackSchema,
  proposalFailureSchema,
  proposalRequestSchema,
  proposalRunSchema,
} from './track-proposals.js';

const track = {
  id: '1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed',
  runId: null,
  source: 'manual',
  edited: false,
  firstSegment: 1,
  lastSegment: 4,
  startMs: 0,
  endMs: 6_000,
  kind: 'qa',
  title: 'O que é a burracheira?',
  askerVoice: 2,
  answererVoice: 1,
  askerSpeakerId: null,
  answererSpeakerId: null,
};

describe('track proposal contracts (KBC-067)', () => {
  it('runs for real unless the request asks only for the estimate', () => {
    expect(proposalRequestSchema.parse({})).toEqual({ dryRun: false });
    expect(proposalRequestSchema.parse({ dryRun: true }).dryRun).toBe(true);
    expect(proposalRequestSchema.safeParse({ dry: true }).success).toBe(false);
  });

  it('keeps titles up to 120 characters and voices from 1 to 10', () => {
    expect(draftTrackSchema.parse(track).title).toBe('O que é a burracheira?');
    expect(draftTrackSchema.parse({ ...track, title: null }).title).toBeNull();
    expect(
      draftTrackSchema.safeParse({ ...track, title: 'x'.repeat(121) }).success,
    ).toBe(false);
    expect(
      draftTrackSchema.safeParse({ ...track, askerVoice: 11 }).success,
    ).toBe(false);
  });

  it('names why a run could not propose', () => {
    const run = {
      id: track.id,
      mediaId: track.id,
      status: 'failed',
      model: 'deepseek/deepseek-v4-flash',
      windowsTotal: 6,
      windowsDone: 2,
      tracks: 0,
      estimateUsd: 0.004,
      limitUsd: 0.004,
      spentUsd: 0.001,
      failure: 'provider',
      createdAt: '2026-11-03T15:00:00.000Z',
      finishedAt: '2026-11-03T15:00:30.000Z',
    };
    expect(proposalRunSchema.parse(run).failure).toBe('provider');
    expect(
      proposalRunSchema.safeParse({ ...run, failure: 'timeout' }).success,
    ).toBe(false);
  });

  it('says a run stopped at the value accepted, with what it left (KBC-112 FR-2, FR-3)', () => {
    expect(proposalFailureSchema.parse('accepted-limit')).toBe(
      'accepted-limit',
    );
    expect(stageFailureSchema.parse('accepted-limit')).toBe('accepted-limit');
    const stop = {
      limitUsd: 0.024,
      spentUsd: 0.018,
      windowsDone: 7,
      windowsTotal: 9,
    };
    expect(acceptedLimitStopSchema.parse(stop)).toEqual(stop);
    expect(
      acceptedLimitStopSchema.safeParse({ ...stop, windowsTotal: 0 }).success,
    ).toBe(false);
  });
});
