import { aTopic } from '../../testing/fixtures.js';
import {
  collectionTree,
  groupByRecency,
  inVisibleCollections,
  matches,
  orderByTitle,
  orderCollections,
  savedWhen,
  shows,
  type LibraryView,
} from './library-list.js';

const view = (patch: Partial<LibraryView> = {}): LibraryView => ({
  kind: null,
  order: 'recent',
  query: '',
  ...patch,
});

const topics = [
  aTopic({ slug: 'hermetismo', title: 'Hermetismo' }),
  aTopic({ slug: 'cabala', title: 'Cabala' }),
  aTopic({ slug: 'alquimia', title: 'Alquimia Prática' }),
  aTopic({ slug: 'alquimia/metais', title: 'Metais', parent: 'alquimia' }),
];
const slugs = (list: { slug: string }[]) => list.map((t) => t.slug);

describe('Sua biblioteca list (KBC-125 FR-5)', () => {
  it('"Recentes" puts the last chosen first and keeps the tree order for the rest', () => {
    expect(
      slugs(orderCollections(topics, view(), { cabala: 20, alquimia: 10 })),
    ).toEqual(['cabala', 'alquimia', 'alquimia/metais', 'hermetismo']);
  });

  it('a sub-collection chosen last brings its group up, still under its parent', () => {
    expect(
      slugs(
        orderCollections(topics, view(), { 'alquimia/metais': 30, cabala: 20 }),
      ),
    ).toEqual(['alquimia', 'alquimia/metais', 'cabala', 'hermetismo']);
  });

  it('the alphabetical order keeps each sub-collection under its parent', () => {
    expect(
      slugs(orderCollections(topics, view({ order: 'alpha' }), {})),
    ).toEqual(['alquimia', 'alquimia/metais', 'cabala', 'hermetismo']);
  });

  it('the search ignores accents and case', () => {
    expect(matches('Alquimia Prática', 'PRATICA')).toBe(true);
    expect(slugs(orderCollections(topics, view({ query: 'cab' }), {}))).toEqual(
      ['cabala'],
    );
    expect(
      orderByTitle(
        [{ title: 'lei do ritmo' }, { title: 'A natureza sétupla' }],
        view({ order: 'alpha', query: 'a' }),
      ).map((c) => c.title),
    ).toEqual(['A natureza sétupla']);
  });

  it('each chip shows its own group; with none, everything but the documents', () => {
    expect(shows(null, 'collections')).toBe(true);
    expect(shows(null, 'documents')).toBe(false);
    expect(shows('audio', 'collections')).toBe(false);
    expect(shows('documents', 'documents')).toBe(true);
  });

  it('D5: conversations split into Hoje, Últimos 7 dias and Mais antigas, in the order given', () => {
    const now = new Date(2026, 10, 16, 15, 0);
    const at = (days: number, hours = 0) =>
      new Date(2026, 10, 16 - days, 9 + hours).toISOString();
    const groups = groupByRecency(
      [
        { title: 'agora', updatedAt: at(0) },
        { title: 'ontem', updatedAt: at(1) },
        { title: 'semana', updatedAt: at(7) },
        { title: 'velha', updatedAt: at(8) },
        {
          title: 'cedo',
          updatedAt: new Date(2026, 10, 16, 0, 5).toISOString(),
        },
      ],
      now,
    );
    expect(groups.map((g) => [g.group, g.items.map((i) => i.title)])).toEqual([
      ['today', ['agora', 'cedo']],
      ['week', ['ontem', 'semana']],
      ['older', ['velha']],
    ]);
  });

  it('D5: an empty recency group is left out', () => {
    const now = new Date(2026, 10, 16, 15, 0);
    expect(
      groupByRecency(
        [{ updatedAt: new Date(2020, 0, 1).toISOString() }],
        now,
      ).map((g) => g.group),
    ).toEqual(['older']);
    expect(groupByRecency([], now)).toEqual([]);
  });

  it('D5: the ordered collections become a tree of tops with their sub-collections', () => {
    const entries = orderCollections(topics, view({ order: 'alpha' }), {}).map(
      (topic) => ({ topic }),
    );
    expect(
      collectionTree(entries).map((node) => [
        node.entry.topic.slug,
        node.children.map((child) => child.topic.slug),
      ]),
    ).toEqual([
      ['alquimia', ['alquimia/metais']],
      ['cabala', []],
      ['hermetismo', []],
    ]);
  });

  it('D5: a sub-collection whose parent is filtered out stands as a top of its own', () => {
    const entries = orderCollections(topics, view({ query: 'metais' }), {}).map(
      (topic) => ({ topic }),
    );
    expect(
      collectionTree(entries).map((node) => node.entry.topic.slug),
    ).toEqual(['alquimia/metais']);
  });
});

describe('the recent documents (KBC-125 FR-5)', () => {
  it('lists only documents of collections the person sees now', () => {
    const docs = [
      { topic: 'hermetismo', id: 'a.md', title: 'Caibalion' },
      { topic: 'restrito', id: 'b.md', title: 'Nível fechado' },
    ];
    expect(
      inVisibleCollections(docs, new Set(['hermetismo'])).map((d) => d.title),
    ).toEqual(['Caibalion']);
  });
});

describe('savedWhen (v2 · Sua biblioteca, a conversation row)', () => {
  const now = new Date(2026, 10, 18, 15, 30);
  const at = (...parts: [number, number, number, number, number]) =>
    new Date(...parts).toISOString();

  it('says "agora" within five minutes, then the minutes within the hour', () => {
    expect(savedWhen(at(2026, 10, 18, 15, 27), now)).toBe('agora');
    expect(savedWhen(at(2026, 10, 18, 15, 5), now)).toBe('há 25 min');
  });

  it('gives the time on the same day, the day and month this year, else the full date', () => {
    expect(savedWhen(at(2026, 10, 18, 9, 4), now)).toBe('09:04');
    expect(savedWhen(at(2026, 10, 12, 12, 0), now)).toBe('12/11');
    expect(savedWhen(at(2025, 2, 3, 12, 0), now)).toBe('03/03/2025');
  });
});
