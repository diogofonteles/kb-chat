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
  ...overrides,
});

export const aResponse = (
  items: SearchHit[] = [aHit()],
  overrides: Partial<SearchResponse> = {},
): SearchResponse => ({
  items,
  total: items.length,
  capped: false,
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
  ...overrides,
});

export const TOPICS: TopicList = {
  items: [
    { slug: 'hermetismo', title: 'Hermetismo', documentCount: 4235 },
    { slug: 'alquimia', title: 'Alquimia', documentCount: 1 },
  ],
  defaultSlug: null,
};
