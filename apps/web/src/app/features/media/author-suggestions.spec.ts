import type { Author } from '@kb-chat/contracts';
import { MAX_SUGGESTIONS, suggestAuthors } from './author-suggestions.js';

const author = (name: string, main = false): Author => ({
  slug: name
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-'),
  name,
  main,
});

const AUTHORS = [
  author('Ana Souza'),
  author('Mestre Gabriel', true),
  author('José Gabriel'),
];

describe('author suggestions (KBC-049 FR-3)', () => {
  it('finds a name by any part, accents and case aside, the main author first', () => {
    const found = suggestAuthors(AUTHORS, 'gabri');

    expect(found.authors.map((one) => one.name)).toEqual([
      'Mestre Gabriel',
      'José Gabriel',
    ]);
    expect(found.register).toBe('gabri');
    expect(suggestAuthors(AUTHORS, 'JOSE').authors[0]?.name).toBe(
      'José Gabriel',
    );
  });

  it('offers to register only a name the list does not have', () => {
    expect(suggestAuthors(AUTHORS, ' mestre gabriel ').register).toBeNull();
    expect(suggestAuthors(AUTHORS, 'Mestre Pedro').register).toBe(
      'Mestre Pedro',
    );
    expect(suggestAuthors(AUTHORS, '!!').register).toBeNull();
    expect(suggestAuthors([], '').register).toBeNull();
  });

  it(`shows at most ${MAX_SUGGESTIONS} and answers within 100 ms with 500 authors (NFR-1)`, () => {
    const many = Array.from({ length: 500 }, (_, i) =>
      author(`Autor ${i} Silva`),
    );
    const started = performance.now();
    for (const text of ['a', 'au', 'aut', 'autor 4', 'silva', 'autor 499'])
      suggestAuthors(many, text);
    const elapsed = performance.now() - started;

    expect(suggestAuthors(many, 'silva').authors).toHaveLength(MAX_SUGGESTIONS);
    // Six keystrokes, so each one well under the 100 ms budget.
    expect(elapsed).toBeLessThan(100);
  });
});
