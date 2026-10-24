import { describe, expect, it } from 'vitest';
import { toCatalogEntry, toConceptName } from './catalog-entry.js';
import { splitFrontmatter } from './frontmatter.js';
import { titleFromId, toDisplayTitle } from './titles.js';

describe('toCatalogEntry', () => {
  it('maps kb frontmatter to facets', () => {
    const entry = toCatalogEntry('raw/articles/x.md', {
      title: 'A  NATUREZA  SÉTUPLA',
      summary: ' Resumo ',
      genre: 'talk_or_interview',
      depth: 1.3,
      relevance: 'core',
      concepts: [
        '[[hermetismo/wiki/concepts/Cabala]]',
        '[[Cabala]]',
        'Gnosticismo',
      ],
    });
    expect(entry).toEqual({
      id: 'raw/articles/x.md',
      title: 'A Natureza Sétupla',
      summary: 'Resumo',
      genre: 'talk_or_interview',
      depth: 1,
      relevance: 'core',
      concepts: ['Cabala', 'Gnosticismo'],
    });
  });

  it('nulls unknown facet values and clamps depth', () => {
    const entry = toCatalogEntry('raw/articles/a-lei-do-ritmo-2.md', {
      genre: 'poem',
      relevance: 42,
      depth: 7,
      concepts: 'Cabala',
    });
    expect(entry).toMatchObject({
      title: 'A lei do ritmo',
      genre: null,
      relevance: null,
      depth: 3,
      concepts: [],
    });
  });

  it('treats a non-numeric depth as unknown', () => {
    expect(toCatalogEntry('a.md', { depth: 'deep' }).depth).toBeNull();
  });
});

describe('toConceptName', () => {
  it('drops wikilink brackets, paths and aliases', () => {
    expect(toConceptName('[[wiki/concepts/Cabala|a Cabala]]')).toBe('Cabala');
    expect(toConceptName('  Alquimia ')).toBe('Alquimia');
  });
});

describe('titles', () => {
  it('keeps mixed-case titles as written', () => {
    expect(toDisplayTitle('Torta de  pêssego')).toBe('Torta de pêssego');
  });

  it('title-cases shouting titles keeping small words lowercase', () => {
    expect(toDisplayTitle('O MITO DA PÉROLA E O REGRESSO')).toBe(
      'O Mito da Pérola e o Regresso',
    );
  });

  it('derives a title from the file name', () => {
    expect(titleFromId('raw/articles/meios-de-defesa-3.md')).toBe(
      'Meios de defesa',
    );
  });
});

describe('splitFrontmatter', () => {
  it('returns the body without the YAML block', () => {
    expect(splitFrontmatter('---\ntitle: X\n---\nCorpo')).toEqual({
      data: { title: 'X' },
      body: 'Corpo',
    });
  });

  it('keeps text without frontmatter as the body', () => {
    expect(splitFrontmatter('Só corpo')).toEqual({
      data: {},
      body: 'Só corpo',
    });
  });

  it('ignores invalid or non-object YAML', () => {
    expect(splitFrontmatter('---\n: : :\n---\nB').data).toEqual({});
    expect(splitFrontmatter('---\n- a\n---\nB').data).toEqual({});
  });
});
