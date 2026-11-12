import type { LiveTrackLevel } from '../../ports/media-store.js';

/** A track's place among its recording's tracks: "faixa 2 de 3". */
export interface TrackPlace {
  /** Null when the track is not among the live ones the person hears. */
  readonly ordinal: number | null;
  readonly total: number;
}

/**
 * KBC-111 (owner decision, 2026-11-12): a track's number and its recording's total are
 * counted over the tracks the person hears, so neither tells how many are above their level.
 */
export function placeAmongHeard(
  live: readonly LiveTrackLevel[],
  mediaId: string,
  hears: (level: string | null) => boolean,
): TrackPlace {
  const ids = [
    ...new Set(
      [...live]
        .sort((a, b) => a.startMs - b.startMs)
        .filter((track) => hears(track.level))
        .map((track) => track.mediaId),
    ),
  ];
  const at = ids.indexOf(mediaId);
  return { ordinal: at < 0 ? null : at + 1, total: ids.length };
}
