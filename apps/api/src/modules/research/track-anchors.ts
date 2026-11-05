import { TRACK_ANCHOR, clockSeconds } from '@kb-chat/contracts';

/** The anchors written in a text, in order, as seconds on the track's clock. */
export function anchorsIn(text: string): number[] {
  return [...text.matchAll(new RegExp(TRACK_ANCHOR.source, 'g'))]
    .map((match) => clockSeconds(match[1] ?? ''))
    .filter((seconds): seconds is number => seconds !== null);
}

/**
 * The anchor of the paragraph `offset` falls in: the last one at or before it in the body,
 * or null before the first (the title and the recording line).
 */
export function anchorAt(body: string, offset: number): number | null {
  let found: number | null = null;
  for (const match of body.matchAll(new RegExp(TRACK_ANCHOR.source, 'g'))) {
    if (match.index > offset) break;
    found = clockSeconds(match[1] ?? '') ?? found;
  }
  return found;
}
