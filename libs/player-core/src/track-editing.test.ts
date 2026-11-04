import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  MIN_TRACK_LENGTH_MS,
  NUDGE_MS,
  canSplit,
  canSplitAt,
  clampHandle,
  joinTracks,
  landHandle,
  limitsOf,
  neighbourPoint,
  newTrackSpan,
  selectedSpan,
  snapPointsOf,
  snapTo,
  splitPointNear,
  withHandle,
  type TrackEdge,
  type TrackSpan,
} from './track-editing.js';

const DURATION = 3_600_000;
const span = (id: string, startMs: number, endMs: number): TrackSpan => ({
  id,
  startMs,
  endMs,
});
const NO_SNAP = { start: [], end: [] };
const limits = (tracks: TrackSpan[], trackId: string, edge: TrackEdge) =>
  limitsOf(tracks, { trackId, edge, durationMs: DURATION });

describe('a released handle (BR-2)', () => {
  it('snaps a start to the word that begins 200 ms away (AC-2)', () => {
    const tracks = [span('a', 725_000, 760_000)];
    const snap = snapPointsOf([{ startMs: 724_200, endMs: 724_600 }], []);
    const landed = landHandle(
      { toMs: 724_400, edge: 'start' },
      { limits: limits(tracks, 'a', 'start'), snap },
    );
    expect(landed).toEqual({ ms: 724_200, stop: null });
  });

  it('snaps to the middle of a pause, and to a word end for an end handle', () => {
    const snap = snapPointsOf(
      [{ startMs: 1_000, endMs: 2_000 }],
      [{ startMs: 5_000, endMs: 7_000 }],
    );
    expect(snap.start).toEqual([1_000, 6_000]);
    expect(snap.end).toEqual([2_000, 6_000]);
  });

  it('keeps the loose time past 300 ms or with no words there', () => {
    expect(snapTo(1_000, [1_301])).toBeNull();
    expect(snapTo(1_000, [1_300])).toBe(1_300);
    expect(snapTo(1_000, [])).toBeNull();
  });

  it('never snaps past a limit', () => {
    const tracks = [span('a', 0, 10_000), span('b', 10_000, 20_000)];
    const landed = landHandle(
      { toMs: 9_900, edge: 'end' },
      {
        limits: limits(tracks, 'a', 'end'),
        snap: { start: [], end: [10_100] },
      },
    );
    expect(landed).toEqual({ ms: 9_900, stop: null });
  });
});

describe('where a handle stops (BR-3, BR-4)', () => {
  it('stops at the neighbour and names it (AC-4)', () => {
    const tracks = [
      span('2', 0, 800_000),
      span('3', 800_000, 947_000),
      span('4', 947_000, 990_000),
    ];
    const landed = landHandle(
      { toMs: 970_000, edge: 'end' },
      { limits: limits(tracks, '3', 'end'), snap: NO_SNAP },
    );
    expect(landed).toEqual({
      ms: 947_000,
      stop: { kind: 'neighbour', ordinal: 3 },
    });
  });

  it('stops at 5 s from the other handle (AC-5)', () => {
    const tracks = [span('a', 10_000, 16_000)];
    const landed = landHandle(
      { toMs: 13_000, edge: 'start' },
      { limits: limits(tracks, 'a', 'start'), snap: NO_SNAP },
    );
    expect(landed).toEqual({ ms: 11_000, stop: { kind: 'minimum' } });
  });

  it('nudges 0,5 s without snapping (AC-3)', () => {
    const tracks = [span('a', 0, 10_000)];
    const landed = clampHandle(10_000 + NUDGE_MS, limits(tracks, 'a', 'end'));
    expect(landed).toEqual({ ms: 10_500, stop: null });
  });
});

describe('the arrows on a handle (FR-4)', () => {
  it('goes to the next or previous word edge', () => {
    const points = [1_000, 2_000, 3_000];
    expect(neighbourPoint(2_000, { points, direction: 1 })).toBe(3_000);
    expect(neighbourPoint(2_000, { points, direction: -1 })).toBe(1_000);
    expect(neighbourPoint(3_000, { points, direction: 1 })).toBeNull();
    expect(neighbourPoint(1_000, { points, direction: -1 })).toBeNull();
  });
});

describe('dividing and joining (FR-6)', () => {
  it('does not offer to divide a track of 9 s (AC-5)', () => {
    expect(canSplit(span('a', 0, 9_000))).toBe(false);
    expect(canSplit(span('a', 0, 10_000))).toBe(true);
  });

  it('divides only where both parts keep 5 s', () => {
    const track = span('a', 0, 12_000);
    expect(canSplitAt(track, 5_000)).toBe(true);
    expect(canSplitAt(track, 4_999)).toBe(false);
    expect(canSplitAt(track, 7_001)).toBe(false);
    expect(splitPointNear(track, 1_000)).toBe(5_000);
    expect(splitPointNear(track, 11_000)).toBe(7_000);
  });

  it('joins with the next, to its end, keeping the first (AC-10)', () => {
    const joined = joinTracks(
      [
        { ...span('a', 0, 10_000), title: 'Primeira' },
        { ...span('b', 12_000, 20_000), title: 'Segunda' },
      ],
      'a',
    );
    expect(joined).toEqual([{ ...span('a', 0, 20_000), title: 'Primeira' }]);
  });
});

describe('creating (BR-3)', () => {
  it('starts where asked, inside the gap', () => {
    expect(
      newTrackSpan([span('a', 0, 10_000)], { atMs: 20_000, durationMs: DURATION }),
    ).toEqual({ startMs: 20_000, endMs: 80_000 });
  });

  it('stays in a short gap and refuses one of less than 5 s', () => {
    const tracks = [span('a', 0, 10_000), span('b', 18_000, 30_000)];
    expect(newTrackSpan(tracks, { atMs: 17_000, durationMs: DURATION })).toEqual(
      { startMs: 13_000, endMs: 18_000 },
    );
    const tight = [span('a', 0, 10_000), span('b', 14_000, 30_000)];
    expect(
      newTrackSpan(tight, { atMs: 12_000, durationMs: DURATION }),
    ).toBeNull();
    expect(
      newTrackSpan(tight, { atMs: 5_000, durationMs: DURATION }),
    ).toBeNull();
  });

  it('clips a text selection to the free room', () => {
    const tracks = [span('b', 20_000, 30_000)];
    const input = { startMs: 10_000, endMs: 40_000, durationMs: DURATION };
    expect(selectedSpan(tracks, input)).toEqual({
      startMs: 10_000,
      endMs: 20_000,
    });
    expect(
      selectedSpan(tracks, { ...input, startMs: 16_000 }),
    ).toBeNull();
  });
});

/** The promise of the item: whatever a person does, tracks never break the rules. */
describe('any sequence of actions (BR-3, BR-4)', () => {
  type Action =
    | { kind: 'move'; index: number; edge: TrackEdge; toMs: number }
    | { kind: 'join'; index: number }
    | { kind: 'split'; index: number; atMs: number }
    | { kind: 'create'; atMs: number };

  const anAction: fc.Arbitrary<Action> = fc.oneof(
    fc.record({
      kind: fc.constant('move' as const),
      index: fc.nat(30),
      edge: fc.constantFrom<TrackEdge>('start', 'end'),
      toMs: fc.integer({ min: -5_000, max: DURATION + 5_000 }),
    }),
    fc.record({ kind: fc.constant('join' as const), index: fc.nat(30) }),
    fc.record({
      kind: fc.constant('split' as const),
      index: fc.nat(30),
      atMs: fc.integer({ min: 0, max: DURATION }),
    }),
    fc.record({
      kind: fc.constant('create' as const),
      atMs: fc.integer({ min: 0, max: DURATION }),
    }),
  );

  function applyAction(tracks: TrackSpan[], action: Action): TrackSpan[] {
    if (action.kind === 'create') {
      const span = newTrackSpan(tracks, {
        atMs: action.atMs,
        durationMs: DURATION,
      });
      return span ? [...tracks, { id: `n${tracks.length}${action.atMs}`, ...span }] : tracks;
    }
    const track = tracks[action.index % Math.max(tracks.length, 1)];
    if (!track) return tracks;
    if (action.kind === 'join') return joinTracks(tracks, track.id);
    if (action.kind === 'split') {
      if (!canSplit(track)) return tracks;
      const ms = splitPointNear(track, action.atMs);
      return [
        ...tracks.filter((one) => one.id !== track.id),
        { ...track, endMs: ms },
        { id: `${track.id}s${ms}`, startMs: ms, endMs: track.endMs },
      ];
    }
    const { ms } = landHandle(
      { toMs: action.toMs, edge: action.edge },
      {
        limits: limits(tracks, track.id, action.edge),
        snap: { start: [action.toMs + 100], end: [action.toMs - 100] },
      },
    );
    return withHandle(tracks, { trackId: track.id, edge: action.edge, ms });
  }

  it('never overlaps and never leaves a track under 5 s', () => {
    fc.assert(
      fc.property(fc.array(anAction, { maxLength: 60 }), (actions) => {
        let tracks: TrackSpan[] = [span('a', 100_000, 200_000)];
        for (const action of actions) {
          tracks = applyAction(tracks, action);
          const ordered = [...tracks].sort((a, b) => a.startMs - b.startMs);
          ordered.forEach((one, index) => {
            expect(one.endMs - one.startMs).toBeGreaterThanOrEqual(
              MIN_TRACK_LENGTH_MS,
            );
            expect(one.startMs).toBeGreaterThanOrEqual(0);
            expect(one.endMs).toBeLessThanOrEqual(DURATION);
            const next = ordered[index + 1];
            if (next) expect(one.endMs).toBeLessThanOrEqual(next.startMs);
          });
        }
      }),
      { numRuns: 300 },
    );
  });
});
