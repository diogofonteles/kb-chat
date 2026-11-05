import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  MIN_TRACK_LENGTH_MS,
  adjacentTrack,
  trackAt,
  NUDGE_MS,
  canSplit,
  canSplitAt,
  clampHandle,
  closeOverlap,
  joinTracks,
  landHandle,
  limitsOf,
  neighbourPoint,
  newTrackSpan,
  overlapMs,
  selectedSpan,
  snapPointsOf,
  snapTo,
  splitPointNear,
  splitTrack,
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

  it('divides into two touching tracks, the second made by the caller', () => {
    const tracks = [span('a', 0, 20_000), span('b', 20_000, 30_000)];
    const parts = splitTrack(tracks, {
      trackId: 'a',
      atMs: 1_000,
      second: (track, startMs) => ({ ...track, id: 'c', startMs }),
    });
    expect(parts).toEqual([
      span('a', 0, 5_000),
      span('b', 20_000, 30_000),
      span('c', 5_000, 20_000),
    ]);
  });

  it('refuses to divide what is too short, or is not there', () => {
    const second = (track: TrackSpan) => track;
    const tracks = [span('a', 0, 9_000)];
    expect(
      splitTrack(tracks, { trackId: 'a', atMs: 4_000, second }),
    ).toBeNull();
    expect(
      splitTrack(tracks, { trackId: 'z', atMs: 4_000, second }),
    ).toBeNull();
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
      newTrackSpan([span('a', 0, 10_000)], {
        atMs: 20_000,
        durationMs: DURATION,
      }),
    ).toEqual({ startMs: 20_000, endMs: 80_000 });
  });

  it('stays in a short gap and refuses one of less than 5 s', () => {
    const tracks = [span('a', 0, 10_000), span('b', 18_000, 30_000)];
    expect(
      newTrackSpan(tracks, { atMs: 17_000, durationMs: DURATION }),
    ).toEqual({ startMs: 13_000, endMs: 18_000 });
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
    expect(selectedSpan(tracks, { ...input, startMs: 16_000 })).toBeNull();
  });
});

describe('listening by track (FR-9)', () => {
  const tracks = [
    span('1', 0, 10_000),
    span('2', 10_000, 20_000),
    span('3', 30_000, 40_000),
  ];

  it('finds the track playing, with the end out of it, and none in a gap', () => {
    expect(trackAt(tracks, 10_000)?.id).toBe('2');
    expect(trackAt(tracks, 9_999)?.id).toBe('1');
    expect(trackAt(tracks, 25_000)).toBeNull();
  });

  it('goes to the next or the previous track from anywhere', () => {
    expect(adjacentTrack(tracks, { ms: 15_000, direction: 1 })?.id).toBe('3');
    expect(adjacentTrack(tracks, { ms: 15_000, direction: -1 })?.id).toBe('1');
    expect(adjacentTrack(tracks, { ms: 25_000, direction: -1 })?.id).toBe('2');
    expect(adjacentTrack(tracks, { ms: 35_000, direction: 1 })).toBeNull();
    expect(adjacentTrack(tracks, { ms: 5_000, direction: -1 })).toBeNull();
  });
});

describe('a draft that already holds an overlap (KBC-094)', () => {
  const held = [span('a', 0, 10_042), span('b', 10_000, 20_000)];

  it('says how far a track starts before the ones ahead end', () => {
    expect(overlapMs(held, 'b')).toBe(42);
    expect(overlapMs(held, 'a')).toBe(0);
    expect(overlapMs(held, 'missing')).toBe(0);
  });

  it('counts from the longest track ahead, not just the one before', () => {
    const nested = [
      span('a', 0, 30_000),
      span('b', 5_000, 10_000),
      span('c', 20_000, 40_000),
    ];
    expect(overlapMs(nested, 'c')).toBe(10_000);
  });

  it('closes it by starting the track where the ones ahead end', () => {
    expect(closeOverlap(held, 'b')).toEqual([
      span('a', 0, 10_042),
      span('b', 10_042, 20_000),
    ]);
  });

  it('offers nothing where there is no overlap or 5 s would not be left', () => {
    expect(closeOverlap(held, 'a')).toBeNull();
    expect(
      closeOverlap([span('a', 0, 16_000), span('b', 10_000, 20_000)], 'b'),
    ).toBeNull();
  });

  it('a handle with no room stays where it is, inside the track', () => {
    const tight = [span('a', 0, 10_000), span('b', 9_990, 14_000)];
    const held = limits(tight, 'b', 'start');
    expect(clampHandle(12_000, held).ms).toBe(9_990);
    expect(clampHandle(1_000, held).ms).toBe(9_990);
  });

  it('a start never passes the end of a track held inside another', () => {
    const inside = [span('a', 0, 30_000), span('b', 8_000, 20_000)];
    const landed = landHandle(
      { toMs: 9_000, edge: 'start' },
      { limits: limits(inside, 'b', 'start'), snap: NO_SNAP },
    );
    expect(landed.ms).toBe(8_000);
  });

  it('an end with no room stays where it is too', () => {
    const tight = [span('a', 0, 7_000), span('b', 3_000, 20_000)];
    expect(clampHandle(1_000, limits(tight, 'a', 'end')).ms).toBe(7_000);
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
      return span
        ? [...tracks, { id: `n${tracks.length}${action.atMs}`, ...span }]
        : tracks;
    }
    const track = tracks[action.index % Math.max(tracks.length, 1)];
    if (!track) return tracks;
    if (action.kind === 'join') return joinTracks(tracks, track.id);
    if (action.kind === 'split')
      return (
        splitTrack(tracks, {
          trackId: track.id,
          atMs: action.atMs,
          second: (one, startMs) => ({
            ...one,
            id: `${one.id}s${startMs}`,
            startMs,
          }),
        }) ?? tracks
      );
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
