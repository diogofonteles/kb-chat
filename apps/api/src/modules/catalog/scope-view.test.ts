import { describe, expect, it } from 'vitest';
import type { TopicCatalog } from './catalog.js';
import { toCatalogEntry } from './catalog-entry.js';
import { RelationIndex } from './relations.js';
import { ScopeView } from './scope-view.js';

function catalogOf(slug: string, docs: Record<string, string>): TopicCatalog {
  const entries = new Map(
    Object.entries(docs).map(([id, title]) => [
      id,
      toCatalogEntry(id, { title }),
    ]),
  );
  return {
    topic: { slug, title: slug },
    entries,
    relations: new RelationIndex(entries.values()),
  };
}

describe('ScopeView (KBC-101 FR-5)', () => {
  it('names a sub-collection document from the parent folder and finds its home', () => {
    const view = new ScopeView(catalogOf('udv', { 'raw/articles/a.md': 'A' }), [
      catalogOf('udv/palestras', { 'raw/articles/b.md': 'B' }),
    ]);
    expect([...view.entries.keys()]).toEqual([
      'raw/articles/a.md',
      'palestras/raw/articles/b.md',
    ]);
    expect(view.homeOf('palestras/raw/articles/b.md')).toEqual({
      topic: 'udv/palestras',
      id: 'raw/articles/b.md',
    });
  });

  it('never lets a sub-collection named like a parent folder replace a parent document', () => {
    const view = new ScopeView(
      catalogOf('udv', { 'raw/articles/a.md': 'Do pai' }),
      [catalogOf('udv/raw', { 'articles/a.md': 'Do sub-acervo' })],
    );
    expect(view.entries.get('raw/articles/a.md')?.title).toBe('Do pai');
    expect(view.homeOf('raw/articles/a.md')).toEqual({
      topic: 'udv',
      id: 'raw/articles/a.md',
    });
  });
});
