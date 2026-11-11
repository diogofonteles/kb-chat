/**
 * The seam between a search result and the transcript (KBC-039 FR-3 × KBC-038): which
 * segment of which media to paint. KBC-038's transcript panel takes it as its `passage`
 * input and paints those segments with the CSS Custom Highlight API.
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
