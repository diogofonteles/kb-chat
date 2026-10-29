import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  BOOKMARK_BACK_MS,
  BOOKMARK_NOTE_MAX,
  bookmarkPosition,
  cleanNote,
  sortBookmarks,
} from './bookmarks.js';

describe('bookmarks (KBC-042)', () => {
  it('marks 2 s before the moment, to catch the start of the sentence (BR-2, AC-1)', () => {
    expect(BOOKMARK_BACK_MS).toBe(2_000);
    expect(bookmarkPosition(760_000)).toBe(758_000);
    expect(bookmarkPosition(2_000)).toBe(0);
    expect(bookmarkPosition(2_001)).toBe(1);
  });

  it('never marks before the start (AC-7)', () => {
    expect(bookmarkPosition(1_000)).toBe(0);
    expect(bookmarkPosition(0)).toBe(0);
    expect(bookmarkPosition(-5)).toBe(0);
  });

  it('keeps whole milliseconds', () => {
    expect(bookmarkPosition(12_345.9)).toBe(10_345);
    fc.assert(
      fc.property(fc.double({ min: 0, max: 1e9, noNaN: true }), (ms) => {
        const position = bookmarkPosition(ms);
        return Number.isInteger(position) && position >= 0 && position <= ms;
      }),
    );
  });

  it('keeps a note of up to 2 000 characters, trimmed, and none when blank', () => {
    expect(BOOKMARK_NOTE_MAX).toBe(2_000);
    expect(cleanNote('  lei do ritmo  ')).toBe('lei do ritmo');
    expect(cleanNote('   ')).toBeNull();
    expect(cleanNote('')).toBeNull();
    expect(cleanNote(null)).toBeNull();
    expect(cleanNote('a'.repeat(2_000))).toHaveLength(2_000);
    expect(cleanNote('a'.repeat(2_001))).toHaveLength(2_000);
  });

  it('orders by position, then by creation, without changing the list', () => {
    const list = [
      { id: 'c', positionMs: 30, createdAt: '2026-10-29T10:00:02Z' },
      { id: 'a', positionMs: 10, createdAt: '2026-10-29T10:00:05Z' },
      { id: 'b', positionMs: 30, createdAt: '2026-10-29T10:00:01Z' },
    ];
    const copy = [...list];
    expect(sortBookmarks(list).map((b) => b.id)).toEqual(['a', 'b', 'c']);
    expect(list).toEqual(copy);
  });
});
