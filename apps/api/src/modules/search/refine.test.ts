import { EMPTY_FILTERS, type SearchFilters } from '@kb-chat/contracts';
import { describe, expect, it } from 'vitest';
import type { CatalogEntry } from '../catalog/index.js';
import { copyKey, groupCopies, refine, type Candidate } from './refine.js';

const NO_FILTERS: SearchFilters = EMPTY_FILTERS;

const entry = (
  id: string,
  overrides: Partial<CatalogEntry> = {},
): CatalogEntry => ({
  id,
  title: id,
  summary: null,
  genre: 'article_or_essay',
  depth: 1,
  relevance: 'core',
  concepts: [],
  criterion: null,
  origin: null,
  relations: { exampleOf: [], extends: [], related: [] },
  entities: [],
  sourcePath: null,
  ...overrides,
});
const candidate = (e: CatalogEntry, score = 1): Candidate => ({
  hit: { id: e.id, score, snippet: '' },
  entry: e,
});
const run = (
  candidates: Candidate[],
  filters: Partial<SearchFilters> = {},
  offset = 0,
) =>
  refine(groupCopies(candidates), {
    filters: { ...NO_FILTERS, ...filters },
    offset,
    limit: 10,
    maxResults: 50,
  });

describe('groupCopies', () => {
  it('groups near-identical titles under the best-ranked document', () => {
    const groups = groupCopies([
      candidate(entry('a-2.md', { title: 'A Natureza Sétupla' })),
      candidate(entry('b.md', { title: 'Outro' })),
      candidate(entry('a-5.md', { title: 'A  natureza setupla' })),
    ]);
    expect(groups.map((g) => g.lead.entry.id)).toEqual(['a-2.md', 'b.md']);
    expect(groups[0]?.copies.map((c) => c.id)).toEqual(['a-5.md']);
    expect(copyKey(' A  Natureza  Sétupla ')).toBe('a natureza setupla');
  });
});

describe('refine', () => {
  const cabalaTalk = entry('1.md', {
    concepts: ['Cabala'],
    genre: 'talk_or_interview',
  });
  const cabalaText = entry('2.md', { concepts: ['Cabala'] });
  const guide = entry('3.md', {
    concepts: ['Magia'],
    genre: 'tutorial_or_guide',
    depth: 0,
  });
  const offTopic = entry('4.md', { relevance: 'off_topic', genre: 'other' });
  const all = [cabalaTalk, cabalaText, guide, offTopic].map((e) =>
    candidate(e),
  );

  it('combines facets with AND and values with OR (BR-3)', () => {
    expect(
      run(all, {
        concepts: ['Cabala'],
        genres: ['talk_or_interview'],
      }).page.map((g) => g.lead.entry.id),
    ).toEqual(['1.md']);
    expect(
      run(all, { genres: ['talk_or_interview', 'tutorial_or_guide'] }).total,
    ).toBe(2);
  });

  it('hides off-topic by default and reports how many were hidden (BR-2)', () => {
    const result = run(all);
    expect(result.page.map((g) => g.lead.entry.id)).not.toContain('4.md');
    expect(result.hiddenOffTopic).toBe(1);
    expect(result.facets.relevances).toContainEqual({
      value: 'off_topic',
      count: 1,
    });
  });

  it('adds off-topic to the results when it is selected', () => {
    const result = run(all, { relevances: ['off_topic'] });
    expect(result.page.map((g) => g.lead.entry.id)).toEqual([
      '1.md',
      '2.md',
      '3.md',
      '4.md',
    ]);
    expect(result.hiddenOffTopic).toBe(0);
    const narrowed = run(all, { relevances: ['adjacent', 'off_topic'] });
    expect(narrowed.page.map((g) => g.lead.entry.id)).toEqual(['4.md']);
  });

  it('counts each facet over the results filtered by the other facets (disjunctive)', () => {
    const result = run(all, { genres: ['talk_or_interview'] });
    expect(result.facets.genres).toEqual([
      { value: 'article_or_essay', count: 1 },
      { value: 'talk_or_interview', count: 1 },
      { value: 'tutorial_or_guide', count: 1 },
    ]);
    expect(result.facets.concepts).toEqual([{ value: 'Cabala', count: 1 }]);
    expect(result.facets.depths).toEqual([{ value: 1, count: 1 }]);
  });

  it('pages up to the result cap with a next offset', () => {
    const many = Array.from({ length: 60 }, (_, i) =>
      candidate(entry(`d${i}.md`)),
    );
    expect(run(many).nextOffset).toBe(10);
    const last = run(many, {}, 40);
    expect(last.page).toHaveLength(10);
    expect(last.nextOffset).toBeNull();
    expect(last.total).toBe(60);
  });

  it('returns an empty page when filters remove everything', () => {
    const result = run(all, { concepts: ['Inexistente'] });
    expect(result).toMatchObject({ total: 0, nextOffset: null });
    expect(result.page).toEqual([]);
  });

  it('treats unknown facet values as not matching a filter on that facet', () => {
    const unknown = candidate(
      entry('5.md', { genre: null, depth: null, relevance: null }),
    );
    expect(run([unknown], { genres: ['paper'] }).total).toBe(0);
    expect(run([unknown], { depths: [1] }).total).toBe(0);
    expect(run([unknown], { relevances: ['core'] }).total).toBe(0);
    expect(run([unknown]).total).toBe(1);
  });
});

describe('refine performance (NFR-1)', () => {
  it('filters, groups and counts 200 candidates in under 50 ms', () => {
    const concepts = ['Cabala', 'Alquimia', 'Gnosticismo', 'Carma', 'Magia'];
    const candidates = Array.from({ length: 200 }, (_, i) =>
      candidate(
        entry(`d${i}.md`, {
          title: `Doc ${i % 150}`,
          concepts: [concepts[i % 5] as string],
          depth: (i % 3) as 0 | 1 | 2,
        }),
      ),
    );
    const started = performance.now();
    for (let run = 0; run < 5; run += 1) {
      refine(groupCopies(candidates), {
        filters: { ...NO_FILTERS, concepts: ['Cabala', 'Magia'], depths: [1] },
        offset: 0,
        limit: 10,
        maxResults: 50,
      });
    }
    expect((performance.now() - started) / 5).toBeLessThan(50);
  });
});
