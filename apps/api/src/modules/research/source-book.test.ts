import { describe, expect, it } from 'vitest';
import { SourceBook } from './source-book.js';

describe('SourceBook', () => {
  it('numbers documents in the order they are met and keeps the number for the turn', () => {
    const book = new SourceBook();
    expect(book.number({ id: 'a.md', title: 'A' })).toBe(1);
    expect(book.number({ id: 'b.md', title: 'B' })).toBe(2);
    expect(book.number({ id: 'a.md', title: 'A again' })).toBe(1);
    expect(book.size).toBe(2);
    expect(book.list()).toEqual([
      { n: 1, id: 'a.md', title: 'A' },
      { n: 2, id: 'b.md', title: 'B' },
    ]);
  });

  it('finds a source by number or id and returns copies of the list', () => {
    const book = new SourceBook();
    book.number({ id: 'a.md', title: 'A' });
    expect(book.find(1)).toEqual({ n: 1, id: 'a.md', title: 'A' });
    expect(book.find(2)).toBeUndefined();
    expect(book.findById('a.md')?.n).toBe(1);
    const listed = book.list();
    listed.pop();
    expect(book.list()).toHaveLength(1);
  });
});
