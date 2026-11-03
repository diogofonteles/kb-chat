/**
 * The seam between a search result and the transcript (KBC-039 FR-3 × KBC-038): which
 * segment of which media to mark and keep in view. KBC-038's transcript panel takes it
 * as an input; until then the passage panel shows the segment itself.
 */
export interface PassageFocus {
  readonly mediaId: string;
  readonly startMs: number;
  readonly endMs: number;
}

/** A passage plays from this much before its first word, so the sentence is heard whole. */
export const LEAD_IN_MS = 2_000;

/** Where playback starts for a passage: 2 s before it, never before the start. */
export const playbackStartOf = (passage: {
  readonly startMs: number;
}): number => Math.max(0, passage.startMs - LEAD_IN_MS);
