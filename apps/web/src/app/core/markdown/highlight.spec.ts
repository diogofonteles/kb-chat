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
