import type { TimedSpan } from './cues.js';

/** A word with its times, as the API gives it. */
export interface TimedWord extends TimedSpan {
  readonly text: string;
}

/** A word and where it sits in the text of its segment. */
export interface SpokenWord extends TimedSpan {
  readonly charStart: number;
  readonly charEnd: number;
}

/**
 * Places a segment's words in its text, in order, so they can be painted and hit without
 * an element per word (KBC-045). The API builds the text from these words (ADR 0023 §5),
 * so they match; if one does not, the segment gets none and keeps its own highlight rather
 * than mark the wrong word. Starts never go back: `lastStartedAt` searches them.
 */
export function alignWords(
  text: string,
  words: readonly TimedWord[],
): readonly SpokenWord[] {
  const aligned: SpokenWord[] = [];
  let cursor = 0;
  for (const word of words) {
    if (word.text === '') continue;
    const charStart = text.indexOf(word.text, cursor);
    if (charStart < 0) return [];
    cursor = charStart + word.text.length;
    aligned.push({
      startMs: Math.max(word.startMs, aligned.at(-1)?.startMs ?? 0),
      endMs: word.endMs,
      charStart,
      charEnd: cursor,
    });
  }
  return aligned;
}

/** The last word starting at or before a character of the text (a click on it, FR-3). */
export function wordAtOffset(
  words: readonly SpokenWord[],
  offset: number,
): SpokenWord | null {
  let found: SpokenWord | null = null;
  for (const word of words) {
    if (word.charStart > offset) break;
    found = word;
  }
  return found;
}
