import fc from 'fast-check';
import { remapBookmark, remapPosition } from '@kb-chat/contracts';
import { describe, expect, it } from 'vitest';

const RUNS = { numRuns: 10_000 };

/** A track moved inside a 3 h recording, and something saved inside its old bounds. */
const moved = fc
  .record({
    oldStartMs: fc.integer({ min: 0, max: 10_000_000 }),
    oldLengthMs: fc.integer({ min: 5_000, max: 900_000 }),
    newStartMs: fc.integer({ min: 0, max: 10_000_000 }),
    durationMs: fc.integer({ min: 5_000, max: 900_000 }),
    share: fc.double({ min: 0, max: 1, noNaN: true }),
  })
  .map(({ share, oldLengthMs, ...move }) => ({
    move,
    positionMs: Math.floor(share * oldLengthMs),
  }));

describe('KBC-073 BR-4, NFR-3: everything saved follows the absolute time', () => {
  it('a position lands at the same moment, at 0 or heard, never elsewhere', () => {
    fc.assert(
      fc.property(moved, ({ move, positionMs }) => {
        const absolute = move.oldStartMs + positionMs;
        const offset = absolute - move.newStartMs;
        const landed = remapPosition(positionMs, move);
        if (positionMs === 0)
          expect(landed).toEqual({ positionMs: 0, heard: false });
        else if (offset < 0)
          expect(landed).toEqual({ positionMs: 0, heard: false });
        else if (offset >= move.durationMs)
          expect(landed).toEqual({ positionMs: 0, heard: true });
        else {
          expect(landed.heard).toBe(false);
          expect(move.newStartMs + landed.positionMs).toBe(absolute);
        }
      }),
      RUNS,
    );
  });

  it('a bookmark keeps its moment, in the track or in the recording', () => {
    fc.assert(
      fc.property(moved, ({ move, positionMs }) => {
        const absolute = move.oldStartMs + positionMs;
        const landed = remapBookmark(positionMs, move);
        if (landed.inTrack) {
          expect(move.newStartMs + landed.positionMs).toBe(absolute);
          expect(landed.positionMs).toBeGreaterThanOrEqual(0);
          expect(landed.positionMs).toBeLessThanOrEqual(move.durationMs);
        } else {
          expect(landed.recordingMs).toBe(absolute);
          const outside =
            absolute < move.newStartMs ||
            absolute > move.newStartMs + move.durationMs;
          expect(outside).toBe(true);
        }
      }),
      RUNS,
    );
  });

  it('AC-4: 12:00 to 16:00 becomes 12:30 to 15:30', () => {
    const move = {
      oldStartMs: 720_000,
      newStartMs: 750_000,
      durationMs: 180_000,
    };
    expect(remapPosition(90_000, move)).toEqual({
      positionMs: 60_000,
      heard: false,
    });
    expect(remapBookmark(230_000, move)).toEqual({
      inTrack: false,
      recordingMs: 950_000,
    });
  });
});
