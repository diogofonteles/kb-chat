import type {
  KbDocument,
  SearchHit,
  SearchResponse,
  TopicList,
} from '@kb-chat/contracts';

export const aHit = (overrides: Partial<SearchHit> = {}): SearchHit => ({
  id: 'raw/articles/a-lei-do-ritmo.md',
  title: 'A Lei do Ritmo',
  snippet: 'Os pitagóricos afirmavam que o Universo inteiro…',
  score: 0.9,
  genre: 'article_or_essay',
  depth: 2,
  relevance: 'core',
  concepts: ['Hermetismo e Filosofia Hermética', 'Cabala', 'Gnosticismo'],
  copies: [],
  ...overrides,
});

export const aResponse = (
  items: SearchHit[] = [aHit()],
  overrides: Partial<SearchResponse> = {},
): SearchResponse => ({
  items,
  total: items.length,
  capped: false,
  nextOffset: null,
  hiddenOffTopic: 0,
  facets: {
    concepts: [
      { value: 'Cabala', count: 1 },
      { value: 'Gnosticismo', count: 1 },
    ],
    genres: [{ value: 'article_or_essay', count: 1 }],
    depths: [{ value: 2, count: 1 }],
    relevances: [{ value: 'core', count: 1 }],
  },
  mode: 'all',
  tookMs: 640,
  ...overrides,
});

export const aDocument = (overrides: Partial<KbDocument> = {}): KbDocument => ({
  id: 'raw/articles/a-lei-do-ritmo.md',
  title: 'A Lei do Ritmo',
  summary: 'O texto explora a Lei do Ritmo.',
  body: '# A LEI DO RITMO\n\nOs pitagóricos afirmavam.',
  genre: 'article_or_essay',
  depth: 2,
  relevance: 'core',
  concepts: ['Cabala'],
  criterion: null,
  origin: null,
  obsidianUrl:
    'obsidian://open?vault=hermetismo&file=hermetismo%2Fraw%2Farticles%2Fa-lei-do-ritmo',
  seeAlso: {
    exampleOf: {
      items: [{ id: 'wiki/concepts/Cabala.md', title: 'Cabala' }],
      total: 1,
    },
    extends: { items: [], total: 0 },
    related: { items: [], total: 0 },
    examples: { items: [], total: 0 },
    extendedBy: { items: [], total: 0 },
    relatedFrom: { items: [], total: 0 },
  },
  ...overrides,
});

export const TOPICS: TopicList = {
  items: [
    { slug: 'hermetismo', title: 'Hermetismo', documentCount: 4235 },
    { slug: 'alquimia', title: 'Alquimia', documentCount: 1 },
  ],
  defaultSlug: null,
};
