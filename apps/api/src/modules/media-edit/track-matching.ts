/** A published track item, by where it really sits in the recording. */
export interface PublishedBounds {
  readonly mediaId: string;
  readonly startMs: number;
  readonly endMs: number;
}

/** A track of the new approval. */
export interface NewBounds {
  readonly id: string;
  readonly startMs: number;
  readonly endMs: number;
}

/** How much of the old track the new one must cover to stay the same item (BR-5). */
const SAME_TRACK_SHARE = 0.7;

const overlapOf = (a: NewBounds, b: PublishedBounds): number =>
  Math.max(0, Math.min(a.endMs, b.endMs) - Math.max(a.startMs, b.startMs));

/**
 * Which new track keeps which item (KBC-068 BR-5): each pair covering at least 70 % of the
 * old track is a candidate, and the biggest overlaps choose first, so a split leaves the id
 * with the larger part and a join with the track it covers most. One to one.
 */
export function matchTracks(
  previous: readonly PublishedBounds[],
  next: readonly NewBounds[],
): ReadonlyMap<string, string> {
  const candidates = next
    .flatMap((track) =>
      previous.map((old) => ({
        track,
        old,
        overlap: overlapOf(track, old),
      })),
    )
    .filter(
      ({ old, overlap }) =>
        overlap >= (old.endMs - old.startMs) * SAME_TRACK_SHARE,
    )
    .sort((a, b) => b.overlap - a.overlap);
  const kept = new Map<string, string>();
  const taken = new Set<string>();
  for (const { track, old } of candidates) {
    if (kept.has(track.id) || taken.has(old.mediaId)) continue;
    kept.set(track.id, old.mediaId);
    taken.add(old.mediaId);
  }
  return kept;
}
