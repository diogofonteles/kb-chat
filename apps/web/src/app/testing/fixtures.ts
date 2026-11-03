import type {
  KbDocument,
  SearchHit,
  SearchResponse,
  Topic,
  TopicList,
} from '@kb-chat/contracts';

export const aHit = (overrides: Partial<SearchHit> = {}): SearchHit => ({
  topic: 'hermetismo',
  id: 'raw/articles/a-lei-do-ritmo.md',
  title: 'A Lei do Ritmo',
  snippet: 'Os pitagóricos afirmavam que o Universo inteiro…',
  score: 0.9,
  genre: 'article_or_essay',
  depth: 2,
  relevance: 'core',
  concepts: ['Hermetismo e Filosofia Hermética', 'Cabala', 'Gnosticismo'],
  authorship: 'mestre-laercio',
  author: 'José Laércio do Egito',
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
    authorships: [{ value: 'mestre-laercio', count: 1 }],
    topics: [{ value: 'hermetismo', count: 1 }],
  },
  mode: 'all',
  tookMs: 640,
  ...overrides,
});

const SEE_ALSO: KbDocument['seeAlso'] = {
  exampleOf: {
    items: [
      {
        id: 'wiki/concepts/Cabala.md',
        title: 'Cabala',
        genre: null,
        depth: null,
        relevance: null,
      },
    ],
    total: 1,
  },
  extends: { items: [], total: 0 },
  related: { items: [], total: 0 },
  examples: { items: [], total: 0 },
  extendedBy: { items: [], total: 0 },
  relatedFrom: { items: [], total: 0 },
};

export const aDocument = (overrides: Partial<KbDocument> = {}): KbDocument => ({
  id: 'raw/articles/a-lei-do-ritmo.md',
  title: 'A Lei do Ritmo',
  summary: 'O texto explora a Lei do Ritmo.',
  body: '# A LEI DO RITMO\n\nOs pitagóricos afirmavam.',
  genre: 'article_or_essay',
  depth: 2,
  relevance: 'core',
  concepts: ['Cabala'],
  authorship: 'mestre-laercio',
  author: 'José Laércio do Egito',
  criterion: null,
  origin: null,
  obsidianUrl:
    'obsidian://open?vault=hermetismo&file=hermetismo%2Fraw%2Farticles%2Fa-lei-do-ritmo',
  seeAlso: SEE_ALSO,
  ...overrides,
});

export const aTopic = (
  topic: Pick<Topic, 'slug' | 'title'> & Partial<Topic>,
): Topic => ({
  documentCount: 0,
  parent: null,
  description: '',
  canOpen: true,
  canRename: false,
  ...topic,
});

export const TOPICS: TopicList = {
  items: [
    aTopic({ slug: 'hermetismo', title: 'Hermetismo', documentCount: 4235 }),
    aTopic({ slug: 'alquimia', title: 'Alquimia', documentCount: 1 }),
  ],
  defaultSlug: null,
};
