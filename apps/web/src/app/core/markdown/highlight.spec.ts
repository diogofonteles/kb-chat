import { highlightTerms, markTerms } from './highlight.js';

describe('highlightTerms', () => {
  it('keeps meaningful words, folded and unique', () => {
    expect(highlightTerms('O que é a natureza SÉTUPLA? natureza')).toEqual([
      'natureza',
      'setupla',
    ]);
  });
});

describe('markTerms', () => {
  it('marks accent- and case-insensitive occurrences at word starts', () => {
    expect(
      markTerms('A Natureza Sétupla e a setuplicidade.', [
        'setupla',
        'natureza',
      ]),
    ).toBe('A <mark>Natureza</mark> <mark>Sétupla</mark> e a setuplicidade.');
  });

  it('does not mark inside other words and leaves text without terms untouched', () => {
    expect(markTerms('desnatureza', ['natureza'])).toBe('desnatureza');
    expect(markTerms('texto', [])).toBe('texto');
  });

  it('escapes regex characters in terms', () => {
    expect(markTerms('c++ e c', ['c++'])).toBe('<mark>c++</mark> e c');
  });
});

describe('markTerms on rendered HTML', () => {
  it('marks whole words that start with a term', () => {
    expect(markTerms('<p>as naturezas sétuplas</p>', ['setupla'])).toBe(
      '<p>as naturezas <mark>sétuplas</mark></p>',
    );
  });

  it('leaves links, inline code and code blocks untouched', () => {
    const html =
      '<p><a href="/natureza">natureza</a> e <code>natureza</code> e natureza</p><pre><code>natureza</code></pre>';
    expect(markTerms(html, ['natureza'])).toBe(
      '<p><a href="/natureza">natureza</a> e <code>natureza</code> e <mark>natureza</mark></p><pre><code>natureza</code></pre>',
    );
  });
});
