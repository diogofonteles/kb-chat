/**
 * Bookmarks (KBC-042), as pure rules: where a mark lands, what a note keeps and the order
 * of a list.
 */

/** A mark lands this much before the moment, to catch the start of the sentence (BR-2). */
export const BOOKMARK_BACK_MS = 2_000;

/** The longest note (FR-2). */
export const BOOKMARK_NOTE_MAX = 2_000;

/** Where a mark made at this moment lands: 2 s earlier, never before the start. */
export function bookmarkPosition(currentMs: number): number {
  return Math.max(0, Math.floor(currentMs) - BOOKMARK_BACK_MS);
}

/** A note as kept: trimmed, at most 2 000 characters, and none when blank. */
export function cleanNote(note: string | null): string | null {
  const trimmed = note?.trim() ?? '';
  return trimmed === '' ? null : trimmed.slice(0, BOOKMARK_NOTE_MAX);
}

interface Ordered {
  readonly positionMs: number;
  readonly createdAt: string;
}

/** The list by position, then by creation (a new copy). */
export function sortBookmarks<T extends Ordered>(list: readonly T[]): T[] {
  return [...list].sort(
    (a, b) =>
      a.positionMs - b.positionMs || a.createdAt.localeCompare(b.createdAt),
  );
}
