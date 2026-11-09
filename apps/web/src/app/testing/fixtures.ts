import type {
  KbDocument,
  MediaHit,
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
  trackTotal: items.filter((hit) => hit.media).length,
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
  media: [],
  kinds: { text: items.length, audio: null },
  mode: 'all',
  tookMs: 640,
  ...overrides,
});

/** A spoken passage (KBC-039): "Tiuaco é Mariri" at 08:15. */
export const aMediaHit = (overrides: Partial<MediaHit> = {}): MediaHit => ({
  mediaId: '6f1c2b9b-8a11-4d0a-9d55-0b6f1f0e6a3e',
  topic: 'hermetismo',
  title: 'Palestra do Tiuaco',
  authorship: 'outros-autores',
  author: null,
  text: 'Tiuaco é Mariri na história.',
  highlights: [
    { start: 0, end: 6 },
    { start: 9, end: 15 },
  ],
  startMs: 495_000,
  endMs: 499_000,
  confidence: 'normal',
  score: 0.95,
  match: 'speech',
  subjects: [],
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
  concept: null,
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
  trackCount: 0,
  parent: null,
  description: '',
  canOpen: true,
  canRename: false,
  mainAuthor: null,
  ...topic,
});

export const TOPICS: TopicList = {
  items: [
    aTopic({ slug: 'hermetismo', title: 'Hermetismo', documentCount: 4235 }),
    aTopic({ slug: 'alquimia', title: 'Alquimia', documentCount: 1 }),
  ],
  defaultSlug: null,
};
