/** Largest slice of a document body handed to the model per read (ADR 0006). */
export const WINDOW_CHARS = 12_000;
/** Text kept before the first occurrence, so the passage starts with its context. */
const LEAD_CHARS = 1_500;
/** How far back the start may move to begin at a line. */
const SNAP_CHARS = 400;
const MIN_TERM_LENGTH = 4;

export interface BodyWindow {
  readonly text: string;
  readonly start: number;
  readonly end: number;
  readonly total: number;
  /** Occurrences of `around` inside the window; null when no `around` was asked. */
  readonly matches: number | null;
}

export interface WindowRequest {
  readonly around?: string;
  readonly offset?: number;
}

/** Accent- and case-insensitive folding that keeps one character per character, so positions match. */
export function foldKeepingLength(text: string): string {
  let folded = '';
  for (const char of text.split(''))
    folded +=
      char.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()[0] ?? ' ';
  return folded;
}

function positionsOf(haystack: string, needle: string, from: number): number[] {
  const positions: number[] = [];
  for (
    let at = haystack.indexOf(needle, from);
    at >= 0;
    at = haystack.indexOf(needle, at + needle.length)
  )
    positions.push(at);
  return positions;
}

/** The phrase's occurrences; when the phrase never occurs, those of its longer words. */
function occurrences(folded: string, around: string, from: number): number[] {
  const phrase = foldKeepingLength(around.trim());
  const exact = positionsOf(folded, phrase, from);
  if (exact.length > 0) return exact;
  return phrase
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word.length >= MIN_TERM_LENGTH)
    .flatMap((word) => positionsOf(folded, word, from))
    .sort((a, b) => a - b);
}

const countInside = (positions: readonly number[], start: number): number =>
  positions.filter((p) => p >= start && p < start + WINDOW_CHARS).length;

/** The start whose window holds the most occurrences (the earliest on a tie). */
function densestStart(positions: readonly number[], floor: number): number {
  let best = { start: floor, count: -1 };
  for (const position of positions) {
    const start = Math.max(floor, position - LEAD_CHARS);
    const count = countInside(positions, start);
    if (count > best.count) best = { start, count };
  }
  return best.start;
}

/** Moves the start back to the beginning of its line when that is close. */
function snapToLine(body: string, start: number, floor: number): number {
  if (start <= floor) return floor;
  const lineStart = body.lastIndexOf('\n', start) + 1;
  return start - lineStart <= SNAP_CHARS ? Math.max(floor, lineStart) : start;
}

/**
 * The window of the body to read: centered on the occurrences of `around` (searched from
 * `offset` on), or starting at `offset`, or at the beginning.
 */
export function windowOf(body: string, request: WindowRequest): BodyWindow {
  const total = body.length;
  const floor = Math.min(Math.max(0, request.offset ?? 0), total);
  const positions = request.around
    ? occurrences(foldKeepingLength(body), request.around, floor)
    : [];
  const start =
    positions.length > 0
      ? snapToLine(body, densestStart(positions, floor), floor)
      : floor;
  const end = Math.min(total, start + WINDOW_CHARS);
  return {
    text: body.slice(start, end),
    start,
    end,
    total,
    matches: request.around ? countInside(positions, start) : null,
  };
}
