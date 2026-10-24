import { aHit } from '../../testing/fixtures.js';
import {
  describeForAnnouncement,
  describeResultCount,
} from './result-count.js';

const hits = (n: number) =>
  Array.from({ length: n }, (_, i) => aHit({ id: `d${i}.md` }));

describe('describeResultCount', () => {
  it('counts a complete list', () => {
    expect(
      describeResultCount({ items: hits(1), total: 1, capped: false }),
    ).toBe('1 documento');
    expect(
      describeResultCount({ items: hits(3), total: 3, capped: false }),
    ).toBe('3 documentos');
  });

  it('shows the page against the total, with a plus when capped', () => {
    expect(
      describeResultCount({ items: hits(10), total: 26, capped: false }),
    ).toBe('10 de 26 documentos');
    expect(
      describeResultCount({ items: hits(10), total: 50, capped: true }),
    ).toBe('10 de 50+ documentos');
  });

  it('announces results briefly', () => {
    expect(
      describeForAnnouncement({ items: [], total: 0, capped: false }),
    ).toBe('Nenhum documento encontrado.');
    expect(
      describeForAnnouncement({ items: hits(2), total: 2, capped: false }),
    ).toBe('2 documentos encontrados.');
  });
});
