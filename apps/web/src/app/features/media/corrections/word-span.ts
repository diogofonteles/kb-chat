import { CORRECTION_MAX_WORDS } from '@kb-chat/contracts';

/** Chosen words, by index in a segment's words with text; `clamped` when the focus was cut. */
export interface WordSpan {
  readonly first: number;
  readonly last: number;
  readonly clamped: boolean;
}

/**
 * The words from the anchor to the focus (KBC-115 BR-1): consecutive ones of one segment, at
 * most 5 places from the anchor, counted by place in the transcript (an emptied word between
 * still counts, as the API does). Cut at the 5th, `clamped` says the focus was further.
 */
export function spanAround(
  words: readonly { readonly position: number }[],
  anchor: number,
  focus: number,
): WordSpan {
  const start = words[anchor]?.position ?? 0;
  const step = focus >= anchor ? 1 : -1;
  let reached = anchor;
  for (let index = anchor + step; step * (focus - index) >= 0; index += step) {
    const position = words[index]?.position;
    if (
      position === undefined ||
      Math.abs(position - start) >= CORRECTION_MAX_WORDS
    )
      break;
    reached = index;
  }
  return {
    first: Math.min(anchor, reached),
    last: Math.max(anchor, reached),
    clamped: reached !== focus,
  };
}
