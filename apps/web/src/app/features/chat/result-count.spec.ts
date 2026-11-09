import { aHit, aMediaHit } from '../../testing/fixtures.js';
import {
  describeForAnnouncement,
  describeResultCount,
  describeSpokenCount,
} from './result-count.js';

const hits = (n: number) =>
  Array.from({ length: n }, (_, i) => aHit({ id: `d${i}.md` }));

describe('describeResultCount', () => {
  it('KBC-101 AC-10: names the tracks among the documents', () => {
    expect(
      describeResultCount({
        items: hits(7),
        total: 7,
        capped: false,
        trackTotal: 1,
      }),
    ).toBe('7 documentos (1 faixa)');
    expect(
      describeResultCount({
        items: hits(10),
        total: 26,
        capped: false,
        trackTotal: 3,
      }),
    ).toBe('10 de 26 documentos (3 faixas)');
  });

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
      describeForAnnouncement({
        items: [],
        total: 0,
        capped: false,
        media: [],
      }),
    ).toBe('Nenhum documento encontrado.');
    expect(
      describeForAnnouncement({
        items: hits(2),
        total: 2,
        capped: false,
        media: [],
      }),
    ).toBe('2 documentos encontrados.');
  });

  it('KBC-039: counts the spoken passages too', () => {
    expect(describeSpokenCount(1)).toBe('1 trecho na fala');
    expect(describeSpokenCount(3)).toBe('3 trechos na fala');
    expect(
      describeForAnnouncement({
        items: [],
        total: 0,
        capped: false,
        media: [aMediaHit()],
      }),
    ).toBe('1 trecho na fala encontrado.');
    expect(
      describeForAnnouncement({
        items: hits(2),
        total: 2,
        capped: false,
        media: [aMediaHit(), aMediaHit({ startMs: 1 })],
      }),
    ).toBe('2 documentos e 2 trechos na fala encontrados.');
  });
});
