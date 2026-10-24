import { describe, expect, it } from 'vitest';
import { toCatalogEntry } from './catalog-entry.js';
import { RelationIndex } from './relations.js';

const doc = (id: string, data: Record<string, unknown> = {}) =>
  toCatalogEntry(id, { title: id, ...data });

describe('RelationIndex', () => {
  const cabala = doc('wiki/concepts/Cabala.md', { title: 'Cabala' });
  const alquimia = doc('wiki/concepts/Alquimia.md', { title: 'Alquimia' });
  const tree = doc('raw/a/arvore.md', {
    example_of: ['[[Cabala]]'],
    related: ['[[Inexistente]]'],
  });
  const essay = doc('raw/a/ensaio.md', {
    extends: ['[[hermetismo/wiki/concepts/Cabala]]'],
    related: ['[[Alquimia]]'],
  });
  const index = new RelationIndex([cabala, alquimia, tree, essay]);

  it('resolves forward links to concept articles and drops links without a target (AC-4)', () => {
    const groups = index.groupsOf(tree);
    expect(groups.exampleOf).toMatchObject([
      { id: 'wiki/concepts/Cabala.md', title: 'Cabala' },
    ]);
    expect(groups.related).toEqual([]);
  });

  it('lists in reverse the documents pointing to a concept (AC-3)', () => {
    const groups = index.groupsOf(cabala);
    expect(groups.examples.map((r) => r.id)).toEqual(['raw/a/arvore.md']);
    expect(groups.extendedBy.map((r) => r.id)).toEqual(['raw/a/ensaio.md']);
    expect(groups.relatedFrom).toEqual([]);
    expect(index.groupsOf(alquimia).relatedFrom.map((r) => r.id)).toEqual([
      'raw/a/ensaio.md',
    ]);
  });

  it('ignores a concept that points to itself', () => {
    const self = doc('wiki/concepts/Gnose.md', { related: ['[[Gnose]]'] });
    expect(new RelationIndex([self]).groupsOf(self).relatedFrom).toEqual([]);
  });
});
