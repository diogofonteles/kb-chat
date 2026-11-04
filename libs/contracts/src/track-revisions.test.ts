import { describe, expect, it } from 'vitest';
import {
  remapBookmark,
  remapPosition,
  trackPatchSchema,
} from './track-revisions.js';

const move = { oldStartMs: 10_000, newStartMs: 20_000, durationMs: 30_000 };

describe('remapPosition', () => {
  it('moves with the track, keeps 0, and ends past the new end', () => {
    expect(remapPosition(15_000, move).positionMs).toBe(5_000);
    expect(remapPosition(0, move)).toEqual({ positionMs: 0, heard: false });
    expect(remapPosition(5_000, move)).toEqual({ positionMs: 0, heard: false });
    expect(remapPosition(40_000, move)).toEqual({ positionMs: 0, heard: true });
  });
});

describe('remapBookmark', () => {
  it('stays in the track, or goes to the recording at its moment', () => {
    expect(remapBookmark(10_000, move)).toEqual({
      inTrack: true,
      positionMs: 0,
    });
    expect(remapBookmark(5_000, move)).toEqual({
      inTrack: false,
      recordingMs: 15_000,
    });
  });
});

describe('trackPatchSchema', () => {
  it('reads a blank summary as none and leaves a missing one alone', () => {
    expect(trackPatchSchema.parse({ summary: '  ' }).summary).toBeNull();
    expect(trackPatchSchema.parse({ title: 'x' }).summary).toBeUndefined();
  });

  it('refuses what a track has no such thing as', () => {
    expect(trackPatchSchema.safeParse({ topic: 'x' }).success).toBe(false);
  });
});
