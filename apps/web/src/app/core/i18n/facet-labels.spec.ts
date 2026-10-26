import { describeFacets, modeLabel } from './facet-labels.js';

describe('facet labels', () => {
  it('describes known facets in pt-BR and skips unknown ones', () => {
    expect(
      describeFacets({
        genre: 'talk_or_interview',
        depth: 1,
        relevance: 'core',
      }),
    ).toBe('Aula ou palestra · Intermediário · Central');
    expect(describeFacets({ genre: null, depth: 0, relevance: null })).toBe(
      'Introdutório',
    );
  });

  it('names the search modes', () => {
    expect(modeLabel('exact')).toBe('Palavras exatas');
    expect(modeLabel('semantic')).toBe('Por significado');
  });
});
