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
      criterion: null,
      origin: null,
      relations: { exampleOf: [], extends: [], related: [] },
      entities: [],
      sourcePath: null,
      authorship: 'nao-classificado',
      author: null,
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

describe('relations, criterion and origin', () => {
  it('reads kb relation lists as concept names', () => {
    const entry = toCatalogEntry('raw/a.md', {
      example_of: ['[[Cabala]]'],
      extends: ['[[hermetismo/wiki/concepts/Alquimia]]'],
      related: 'not a list',
      criterion: 'Documentos sobre a Cabala.',
    });
    expect(entry.relations).toEqual({
      exampleOf: ['Cabala'],
      extends: ['Alquimia'],
      related: [],
    });
    expect(entry.criterion).toBe('Documentos sobre a Cabala.');
  });

  it('marks audio transcriptions and OCR texts from the source path', () => {
    expect(
      toCatalogEntry('a.md', { source_path: '_convert/ready/audio/x.wav.txt' })
        .origin,
    ).toBe('audio');
    expect(
      toCatalogEntry('a.md', {
        source_path: '_convert/ready/ocr/Livros/x.pdf.txt',
      }).origin,
    ).toBe('ocr');
    expect(
      toCatalogEntry('a.md', { source_path: '_convert/Temas-docs/x.txt' })
        .origin,
    ).toBeNull();
  });
});

describe('toCatalogEntry entities and source (KBC-017)', () => {
  it('keeps the kb entities (deduplicated, wikilinks unwrapped) and the source path', () => {
    const entry = toCatalogEntry('raw/a.md', {
      entities: [
        'José Laércio do Egito',
        ' FRC ',
        '[[Rosacruz]]',
        'José Laércio do Egito',
        3,
      ],
      source_path: '_convert/Temas-docs/TEMA -0.104 - A DIVULGAÇÃO.txt',
    });
    expect(entry.entities).toEqual([
      'José Laércio do Egito',
      'FRC',
      'Rosacruz',
    ]);
    expect(entry.sourcePath).toBe(
      '_convert/Temas-docs/TEMA -0.104 - A DIVULGAÇÃO.txt',
    );
  });

  it('has no entities nor source path when the frontmatter lacks them', () => {
    const entry = toCatalogEntry('wiki/concepts/Cabala.md', { entities: 'x' });
    expect(entry.entities).toEqual([]);
    expect(entry.sourcePath).toBeNull();
  });
});

describe('toCatalogEntry authorship (KBC-020 AC-1)', () => {
  it('reads the owner-managed author_group and author keys', () => {
    const entry = toCatalogEntry('raw/articles/tema.md', {
      author_group: 'mestre-laercio',
      author: ' José Laércio do Egito ',
    });
    expect(entry.authorship).toBe('mestre-laercio');
    expect(entry.author).toBe('José Laércio do Egito');
    expect(
      toCatalogEntry('raw/articles/livro.md', {
        author_group: 'outros-autores',
      }),
    ).toMatchObject({ authorship: 'outros-autores', author: null });
  });

  it('marks a wiki article without the key as a synthesis of the collection', () => {
    expect(toCatalogEntry('wiki/concepts/Cabala.md', {}).authorship).toBe(
      'sintese',
    );
  });

  it('never guesses: a source without the key or with an unknown value is unclassified', () => {
    const missing = toCatalogEntry('raw/articles/novo.md', {
      source_path: '_convert/Temas-docs/TEMA 1.txt',
      entities: ['José Laércio do Egito'],
    });
    expect(missing.authorship).toBe('nao-classificado');
    expect(
      toCatalogEntry('raw/articles/x.md', { author_group: 'Mestre Laércio' })
        .authorship,
    ).toBe('nao-classificado');
    expect(
      toCatalogEntry('wiki/concepts/X.md', { author_group: 42 }).authorship,
    ).toBe('sintese');
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
