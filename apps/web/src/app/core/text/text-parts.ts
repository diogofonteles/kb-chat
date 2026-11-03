import type { TextRange } from '@kb-chat/contracts';

/** A run of text, marked when it is a word the search found. */
export interface TextPart {
  readonly text: string;
  readonly marked: boolean;
}

/** The text cut at the highlights (sorted, overlaps and out-of-range ones dropped). */
export function textParts(
  text: string,
  highlights: readonly TextRange[],
): TextPart[] {
  const parts: TextPart[] = [];
  let at = 0;
  const ranges = [...highlights].sort((a, b) => a.start - b.start);
  for (const { start, end } of ranges) {
    if (start < at || end > text.length || end <= start) continue;
    if (start > at) parts.push({ text: text.slice(at, start), marked: false });
    parts.push({ text: text.slice(start, end), marked: true });
    at = end;
  }
  if (at < text.length) parts.push({ text: text.slice(at), marked: false });
  return parts;
}
