/**
 * The rules of the track validation (KBC-066): where a handle may go and where it lands,
 * dividing, joining and creating. Pure, so "never overlaps, never under 5 s" can be proved
 * over random action sequences, whatever the screen does.
 */

/** Shortest track (BR-4). */
export const MIN_TRACK_LENGTH_MS = 5_000;
/** How far a released handle looks for a word or a pause (BR-2). */
export const SNAP_RADIUS_MS = 300;
/** The fine adjustment (FR-4): never snaps. */
export const NUDGE_MS = 500;
/** `Shift+←/→` on a handle. */
export const HANDLE_JUMP_MS = 5_000;
/** A new track's length, when the gap has room for it. */
const NEW_TRACK_MS = 60_000;

export interface TrackSpan {
  readonly id: string;
  readonly startMs: number;
  readonly endMs: number;
}

export type TrackEdge = 'start' | 'end';

/** Why a handle stopped (FR-3); a neighbour by its number, as the screen counts them. */
export type HandleStop =
  | { readonly kind: 'neighbour'; readonly ordinal: number }
  | { readonly kind: 'minimum' }
  | { readonly kind: 'recording' };

export interface HandleLimits {
  readonly minMs: number;
  readonly maxMs: number;
  readonly below: HandleStop;
  readonly above: HandleStop;
}

/** Where the handles land: word edges per side, and the middle of each pause (BR-2). */
export interface SnapPoints {
  /** Sorted. */
  readonly start: readonly number[];
  /** Sorted. */
  readonly end: readonly number[];
}

export interface HandleMove {
  readonly trackId: string;
  readonly edge: TrackEdge;
  readonly toMs: number;
}

export interface HandleLanding {
  readonly ms: number;
  readonly stop: HandleStop | null;
}

export interface WordEdge {
  readonly startMs: number;
  readonly endMs: number;
}

/** Words' edges and pauses' middles as the handles use them, each sorted. */
export function snapPointsOf(
  words: readonly WordEdge[],
  pauses: readonly WordEdge[],
): SnapPoints {
  const middles = pauses.map((one) =>
    Math.round((one.startMs + one.endMs) / 2),
  );
  const sorted = (points: readonly number[]) =>
    [...new Set(points)].sort((a, b) => a - b);
  return {
    start: sorted([...words.map((one) => one.startMs), ...middles]),
    end: sorted([...words.map((one) => one.endMs), ...middles]),
  };
}

const byTime = <T extends TrackSpan>(tracks: readonly T[]): T[] =>
  [...tracks].sort((a, b) => a.startMs - b.startMs);

const RECORDING_ENDS: HandleStop = { kind: 'recording' };

/** Bounds for a start between the previous track and 5 s before its end. */
function startLimits(
  track: TrackSpan,
  previous: { track: TrackSpan | undefined; ordinal: number },
): HandleLimits {
  const freeMs = previous.track?.endMs ?? 0;
  const latestMs = track.endMs - MIN_TRACK_LENGTH_MS;
  // An older draft's overlap may leave no room: the handle stays, the neighbour must give way.
  const room = freeMs <= latestMs;
  return {
    minMs: room ? freeMs : track.startMs,
    maxMs: room ? latestMs : track.startMs,
    below: previous.track
      ? { kind: 'neighbour', ordinal: previous.ordinal }
      : RECORDING_ENDS,
    above: { kind: 'minimum' },
  };
}

/** Bounds for an end between 5 s after its start and the next track. */
function endLimits(
  track: TrackSpan,
  next: { track: TrackSpan | undefined; ordinal: number; durationMs: number },
): HandleLimits {
  const earliestMs = track.startMs + MIN_TRACK_LENGTH_MS;
  const nextMs = next.track?.startMs ?? next.durationMs;
  const stuck = next.track !== undefined && nextMs < earliestMs;
  return {
    minMs: stuck ? track.endMs : earliestMs,
    maxMs: stuck ? track.endMs : nextMs,
    below: { kind: 'minimum' },
    above: next.track
      ? { kind: 'neighbour', ordinal: next.ordinal }
      : RECORDING_ENDS,
  };
}

/** How far a handle may go: to the neighbour, to 5 s, to the recording's ends (BR-3, BR-4). */
export function limitsOf(
  tracks: readonly TrackSpan[],
  input: { trackId: string; edge: TrackEdge; durationMs: number },
): HandleLimits {
  const ordered = byTime(tracks);
  const index = ordered.findIndex((one) => one.id === input.trackId);
  const track = ordered[index];
  if (!track)
    return {
      minMs: 0,
      maxMs: input.durationMs,
      below: RECORDING_ENDS,
      above: RECORDING_ENDS,
    };
  return input.edge === 'start'
    ? startLimits(track, { track: ordered[index - 1], ordinal: index })
    : endLimits(track, {
        track: ordered[index + 1],
        ordinal: index + 2,
        durationMs: input.durationMs,
      });
}

/** The nearest point within the radius, or null (no words there: the loose time stands). */
export function snapTo(ms: number, points: readonly number[]): number | null {
  const after = firstAtOrAfter(points, ms);
  const candidates = [points[after - 1], points[after]].filter(
    (one): one is number => one !== undefined,
  );
  const nearest = candidates.sort(
    (a, b) => Math.abs(a - ms) - Math.abs(b - ms),
  )[0];
  return nearest !== undefined && Math.abs(nearest - ms) <= SNAP_RADIUS_MS
    ? nearest
    : null;
}

/** Index of the first point ≥ `ms` (binary search: 2 h is ~15,000 words). */
function firstAtOrAfter(points: readonly number[], ms: number): number {
  let low = 0;
  let high = points.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if ((points[middle] ?? 0) < ms) low = middle + 1;
    else high = middle;
  }
  return low;
}

/** Stops at the limits, and says why (FR-3). */
function clampTo(ms: number, limits: HandleLimits): HandleLanding {
  if (ms < limits.minMs) return { ms: limits.minMs, stop: limits.below };
  if (ms > limits.maxMs) return { ms: limits.maxMs, stop: limits.above };
  return { ms: Math.round(ms), stop: null };
}

/** Where a released handle lands: clamped, then snapped when a point is in reach (BR-2). */
export function landHandle(
  move: { readonly toMs: number; readonly edge: TrackEdge },
  context: { readonly limits: HandleLimits; readonly snap: SnapPoints },
): HandleLanding {
  const landed = clampTo(move.toMs, context.limits);
  if (landed.stop) return landed;
  const snapped = snapTo(landed.ms, context.snap[move.edge]);
  const fits =
    snapped !== null &&
    snapped >= context.limits.minMs &&
    snapped <= context.limits.maxMs;
  return fits ? { ms: snapped, stop: null } : landed;
}

/** Where a loose move lands: the limits, no snapping (the nudge and the arrows' target). */
export const clampHandle = (
  toMs: number,
  limits: HandleLimits,
): HandleLanding => clampTo(toMs, limits);

/** The next word edge after `ms`, or before it (`←/→` on a handle, FR-4). */
export function neighbourPoint(
  ms: number,
  input: { readonly points: readonly number[]; readonly direction: 1 | -1 },
): number | null {
  const { points, direction } = input;
  if (direction > 0) return points[firstAtOrAfter(points, ms + 1)] ?? null;
  return points[firstAtOrAfter(points, ms) - 1] ?? null;
}

/** The tracks with one handle moved to `ms`. */
export function withHandle<T extends TrackSpan>(
  tracks: readonly T[],
  input: { trackId: string; edge: TrackEdge; ms: number },
): T[] {
  const field = input.edge === 'start' ? 'startMs' : 'endMs';
  return tracks.map((one) =>
    one.id === input.trackId ? { ...one, [field]: input.ms } : one,
  );
}

/** Dividing is offered only where both parts keep 5 s (BR-4). */
export const canSplitAt = (track: TrackSpan, ms: number): boolean =>
  ms - track.startMs >= MIN_TRACK_LENGTH_MS &&
  track.endMs - ms >= MIN_TRACK_LENGTH_MS;

/** Any point of this track could divide it: at least 10 s (AC-5: 9 s cannot). */
export const canSplit = (track: TrackSpan): boolean =>
  track.endMs - track.startMs >= 2 * MIN_TRACK_LENGTH_MS;

/** The nearest point to `ms` where the track can divide, keeping 5 s on each side. */
export const splitPointNear = (track: TrackSpan, ms: number): number =>
  Math.min(
    Math.max(ms, track.startMs + MIN_TRACK_LENGTH_MS),
    track.endMs - MIN_TRACK_LENGTH_MS,
  );

/**
 * Divides a track at the point nearest `atMs` (BR-4); null when it is too short. The first
 * part keeps the track, the second is what `second` makes of it from that point on. Null
 * too when the second part's id is taken: every rule finds a track by its id, so two tracks
 * with one id would move together and overlap (BR-3).
 */
export function splitTrack<T extends TrackSpan>(
  tracks: readonly T[],
  input: {
    readonly trackId: string;
    readonly atMs: number;
    readonly second: (track: T, startMs: number) => T;
  },
): T[] | null {
  const track = tracks.find((one) => one.id === input.trackId);
  if (!track || !canSplit(track)) return null;
  const ms = splitPointNear(track, input.atMs);
  const second = input.second(track, ms);
  if (tracks.some((one) => one.id === second.id)) return null;
  return [
    ...tracks.map((one) => (one === track ? { ...one, endMs: ms } : one)),
    second,
  ];
}

/** The gap around `ms` between tracks; null when `ms` is inside a track. */
function gapAround(
  ordered: readonly TrackSpan[],
  input: { atMs: number; durationMs: number },
): { startMs: number; endMs: number } | null {
  const { atMs, durationMs } = input;
  if (ordered.some((one) => atMs >= one.startMs && atMs < one.endMs))
    return null;
  const before = ordered.filter((one) => one.endMs <= atMs).at(-1);
  const after = ordered.find((one) => one.startMs > atMs);
  return { startMs: before?.endMs ?? 0, endMs: after?.startMs ?? durationMs };
}

/**
 * The span of a new track at `atMs`, inside the gap there (BR-3); null when no gap of 5 s
 * holds it. It starts at `atMs` when it can.
 */
export function newTrackSpan(
  tracks: readonly TrackSpan[],
  input: { atMs: number; durationMs: number },
): { startMs: number; endMs: number } | null {
  const gap = gapAround(byTime(tracks), input);
  if (!gap || gap.endMs - gap.startMs < MIN_TRACK_LENGTH_MS) return null;
  const startMs = Math.min(input.atMs, gap.endMs - MIN_TRACK_LENGTH_MS);
  return {
    startMs,
    endMs: Math.min(startMs + NEW_TRACK_MS, gap.endMs),
  };
}

/** A span from a text selection, clipped to the free room there (BR-3); null with too little. */
export function selectedSpan(
  tracks: readonly TrackSpan[],
  input: { startMs: number; endMs: number; durationMs: number },
): { startMs: number; endMs: number } | null {
  const gap = gapAround(byTime(tracks), {
    atMs: input.startMs,
    durationMs: input.durationMs,
  });
  if (!gap) return null;
  const endMs = Math.min(input.endMs, gap.endMs);
  return endMs - input.startMs >= MIN_TRACK_LENGTH_MS
    ? { startMs: input.startMs, endMs }
    : null;
}

/** Where the tracks that start before this one end: the latest of them, 0 with none. */
function freeFrom(tracks: readonly TrackSpan[], track: TrackSpan): number {
  const ordered = byTime(tracks);
  return ordered
    .slice(0, ordered.indexOf(track))
    .reduce((latest, one) => Math.max(latest, one.endMs), 0);
}

/** How far a track starts before the ones ahead of it end, in ms; 0 when it does not. */
export function overlapMs(
  tracks: readonly TrackSpan[],
  trackId: string,
): number {
  const track = tracks.find((one) => one.id === trackId);
  return track ? Math.max(0, freeFrom(tracks, track) - track.startMs) : 0;
}

/**
 * The way out of an overlap an older draft holds (KBC-094): the track starts where the ones
 * ahead of it end. Null when there is none, or when that would leave it under 5 s (BR-4).
 */
export function closeOverlap<T extends TrackSpan>(
  tracks: readonly T[],
  trackId: string,
): T[] | null {
  const track = tracks.find((one) => one.id === trackId);
  if (!track || overlapMs(tracks, trackId) === 0) return null;
  const startMs = freeFrom(tracks, track);
  if (track.endMs - startMs < MIN_TRACK_LENGTH_MS) return null;
  return withHandle(tracks, { trackId, edge: 'start', ms: startMs });
}

/** The track right after this one in time, touching or not; it joins into this one. */
export function nextOf<T extends TrackSpan>(
  tracks: readonly T[],
  trackId: string,
): T | null {
  const ordered = byTime(tracks);
  const index = ordered.findIndex((one) => one.id === trackId);
  return index < 0 ? null : (ordered[index + 1] ?? null);
}

/** Joins a track with the next: the first's fields, to the second's end (FR-6). */
export function joinTracks<T extends TrackSpan>(
  tracks: readonly T[],
  trackId: string,
): T[] {
  const next = nextOf(tracks, trackId);
  if (!next) return [...tracks];
  return tracks
    .filter((one) => one.id !== next.id)
    .map((one) => (one.id === trackId ? { ...one, endMs: next.endMs } : one));
}

/** The track playing at `ms`: `[start, end)`; null in a gap. */
export function trackAt<T extends TrackSpan>(
  tracks: readonly T[],
  ms: number,
): T | null {
  return tracks.find((one) => ms >= one.startMs && ms < one.endMs) ?? null;
}

/** The track "Próxima faixa" or "Faixa anterior" goes to, from `ms` (FR-9). */
export function adjacentTrack<T extends TrackSpan>(
  tracks: readonly T[],
  input: { readonly ms: number; readonly direction: 1 | -1 },
): T | null {
  const { ms, direction } = input;
  if (direction > 0) return tracks.find((one) => one.startMs > ms) ?? null;
  const current = trackAt(tracks, ms);
  const before = current?.startMs ?? ms;
  return tracks.filter((one) => one.startMs < before).at(-1) ?? null;
}
