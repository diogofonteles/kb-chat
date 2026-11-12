import { wordAtOffset, type SpokenWord } from '@kb-chat/player-core';
import { spanAround } from '../corrections/word-span.js';
import type { TextLine } from './track-text-lines.js';

/** A word of a line that has its place in the transcript: one a correction can name. */
export type PlacedSpoken = SpokenWord & { readonly position: number };

/** Where a point falls in the text: a line (by index in the lines shown) and a character. */
export interface TextPoint {
  readonly line: number;
  readonly offset: number;
}

/**
 * Words being chosen by dragging or by Shift+arrows (KBC-115), before the panel has them:
 * always in one line (one segment), from the anchor to the focus, by place.
 */
export interface Gesture {
  readonly line: number;
  readonly anchor: number;
  readonly focus: number;
  /** The gesture went past the segment's edge or the 5th word (BR-1). */
  readonly clamped: boolean;
}

const hasPlace = (word: SpokenWord): word is PlacedSpoken =>
  'position' in word && typeof word.position === 'number';

/** The line's words that a correction can name; none while their page is not here. */
export const placedWords = (line: TextLine | undefined): PlacedSpoken[] =>
  (line?.words ?? []).filter(hasPlace);

/** The word under a character of a line, by place; null where the line has none. */
export function wordAt(
  line: TextLine | undefined,
  offset: number,
): number | null {
  return (
    (wordAtOffset(placedWords(line), offset) as PlacedSpoken | null)
      ?.position ?? null
  );
}

/** Where a gesture starts: a word (by place) of a line (by index in the lines shown). */
export interface GestureStart {
  readonly line: number;
  readonly anchor: number;
}

/** From the anchor's word, by index in its line's words, to the target word. */
interface Reach {
  readonly line: number;
  readonly from: number;
  readonly target: number;
}

/**
 * From the anchor of line `at` to the point (BR-1): a point in another line stops at this
 * line's edge on that side, so a selection never leaves its segment, nor enters a restricted
 * one (BR-2), which has no words anyway.
 */
export function gestureTo(
  lines: readonly TextLine[],
  { line: at, anchor }: GestureStart,
  point: TextPoint,
): Gesture | null {
  const words = placedWords(lines[at]);
  const from = words.findIndex((word) => word.position === anchor);
  if (from < 0) return null;
  const word =
    point.line === at ? wordAtOffset(words, point.offset) : undefined;
  const target =
    point.line === at
      ? Math.max(0, words.indexOf(word as PlacedSpoken))
      : point.line > at
        ? words.length - 1
        : 0;
  return spanned(words, { line: at, from, target }, point.line !== at);
}

/** Shift+→ / Shift+←: the focus one word further, never past the line nor the 5th (FR-4). */
export function gestureStep(
  lines: readonly TextLine[],
  gesture: Gesture,
  direction: 1 | -1,
): Gesture | null {
  const words = placedWords(lines[gesture.line]);
  const from = words.findIndex((word) => word.position === gesture.anchor);
  const focus = words.findIndex((word) => word.position === gesture.focus);
  if (from < 0 || focus < 0) return null;
  const target = focus + direction;
  if (target < 0 || target >= words.length)
    return { ...gesture, clamped: true };
  return spanned(words, { line: gesture.line, from, target }, false);
}

function spanned(
  words: readonly PlacedSpoken[],
  { line, from, target }: Reach,
  outside: boolean,
): Gesture | null {
  const span = spanAround(words, from, target);
  const focus = words[target >= from ? span.last : span.first];
  const anchor = words[from];
  if (!focus || !anchor) return null;
  return {
    line,
    anchor: anchor.position,
    focus: focus.position,
    clamped: span.clamped || outside,
  };
}

/** The gesture's words in its line's text, to paint them; null when they are not there. */
export function gestureOffsets(
  lines: readonly TextLine[],
  gesture: Gesture,
): { readonly start: number; readonly end: number } | null {
  const low = Math.min(gesture.anchor, gesture.focus);
  const high = Math.max(gesture.anchor, gesture.focus);
  const inside = placedWords(lines[gesture.line]).filter(
    (word) => word.position >= low && word.position <= high,
  );
  const first = inside[0];
  const last = inside.at(-1);
  return first && last ? { start: first.charStart, end: last.charEnd } : null;
}
