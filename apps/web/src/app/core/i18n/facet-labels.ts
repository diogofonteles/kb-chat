import type {
  Authorship,
  SearchFilters,
  DepthLevel,
  Genre,
  Relevance,
  SearchMode,
} from '@kb-chat/contracts';

/** UI vocabulary for kb facets (docs/design/screens.md); no kb term reaches the screen. */
export const GENRE_LABELS: Record<Genre, string> = {
  article_or_essay: $localize`:@@genre.article:Texto/apostila`,
  talk_or_interview: $localize`:@@genre.talk:Aula ou palestra`,
  tutorial_or_guide: $localize`:@@genre.tutorial:Guia prático`,
  reference_docs: $localize`:@@genre.reference:Referência`,
  paper: $localize`:@@genre.paper:Estudo acadêmico`,
  announcement_or_news: $localize`:@@genre.news:Aviso`,
  other: $localize`:@@genre.other:Outros`,
};

export const RELEVANCE_LABELS: Record<Relevance, string> = {
  core: $localize`:@@relevance.core:Central`,
  adjacent: $localize`:@@relevance.adjacent:Relacionado`,
  collected_on_purpose: $localize`:@@relevance.collected:Material de estudo`,
  general: $localize`:@@relevance.general:Geral`,
  off_topic: $localize`:@@relevance.offTopic:Fora do tema`,
};

/** KBC-020: whose text a document is (ADR 0015). */
export const AUTHORSHIP_LABELS: Record<Authorship, string> = {
  'mestre-laercio': $localize`:@@authorship.mestre:Mestre Laércio`,
  'outros-autores': $localize`:@@authorship.others:Outros autores`,
  sintese: $localize`:@@authorship.synthesis:Síntese do acervo`,
  'nao-classificado': $localize`:@@authorship.unclassified:Não classificado`,
};

/**
 * The labels of one collection (KBC-049, ADR 0030): the `mestre-laercio` group is its main
 * author, named as the collection names him ("Mestre Laércio" when it has none).
 */
export const authorshipLabelsOf = (
  mainAuthor: string | null,
): Record<Authorship, string> => ({
  ...AUTHORSHIP_LABELS,
  ...(mainAuthor && { 'mestre-laercio': mainAuthor }),
});

export const DEPTH_LABELS: Record<DepthLevel, string> = {
  0: $localize`:@@depth.0:Introdutório`,
  1: $localize`:@@depth.1:Intermediário`,
  2: $localize`:@@depth.2:Aprofundado`,
  3: $localize`:@@depth.3:Avançado`,
};

export interface ModeOption {
  readonly value: SearchMode;
  readonly label: string;
  readonly help: string;
}

export const MODE_OPTIONS: readonly ModeOption[] = [
  {
    value: 'all',
    label: $localize`:@@mode.all:Tudo`,
    help: $localize`:@@mode.all.help:Combina palavras exatas e significado.`,
  },
  {
    value: 'exact',
    label: $localize`:@@mode.exact:Palavras exatas`,
    help: $localize`:@@mode.exact.help:Acha o termo como você escreveu.`,
  },
  {
    value: 'semantic',
    label: $localize`:@@mode.semantic:Por significado`,
    help: $localize`:@@mode.semantic.help:Acha ideias parecidas, mesmo com outras palavras.`,
  },
];

export const modeLabel = (mode: SearchMode): string =>
  MODE_OPTIONS.find((option) => option.value === mode)?.label ?? mode;

/** "Aula ou palestra · Intermediário · Central", skipping unknown values. */
export function describeFacets(facets: {
  readonly genre: Genre | null;
  readonly depth: DepthLevel | null;
  readonly relevance: Relevance | null;
}): string {
  const parts = [
    facets.genre === null ? null : GENRE_LABELS[facets.genre],
    facets.depth === null ? null : DEPTH_LABELS[facets.depth],
    facets.relevance === null ? null : RELEVANCE_LABELS[facets.relevance],
  ];
  return parts.filter((part): part is string => part !== null).join(' · ');
}

/** The facets a search can filter by (single source: the search contract). */
export type FacetKey = keyof SearchFilters;

export const FACET_TITLES: Record<FacetKey, string> = {
  concepts: $localize`:@@facet.concepts:Assuntos`,
  genres: $localize`:@@facet.genres:Tipo de texto`,
  depths: $localize`:@@facet.depths:Profundidade`,
  relevances: $localize`:@@facet.relevances:Ligação com o tema`,
  authorships: $localize`:@@facet.authorships:Autoria`,
  topics: $localize`:@@facet.topics:Sub-acervo`,
};

/** How the open page names collections and authorships (KBC-048, KBC-049). */
export interface FacetNames {
  /** Collections by slug (their slug otherwise). */
  readonly topicNames?: ReadonlyMap<string, string>;
  /** The collection's authorship labels: its main author's name (KBC-049). */
  readonly authorships?: Record<Authorship, string>;
}

/**
 * Display label of one facet value; concepts are already human names, collections and
 * authorships are named by `names`.
 */
export function facetValueLabel(
  key: FacetKey,
  value: string | number,
  { topicNames = new Map(), authorships = AUTHORSHIP_LABELS }: FacetNames = {},
): string {
  if (key === 'topics') return topicNames.get(String(value)) ?? String(value);
  if (key === 'genres') return GENRE_LABELS[value as Genre] ?? String(value);
  if (key === 'depths')
    return DEPTH_LABELS[value as DepthLevel] ?? String(value);
  if (key === 'relevances')
    return RELEVANCE_LABELS[value as Relevance] ?? String(value);
  if (key === 'authorships')
    return authorships[value as Authorship] ?? String(value);
  return String(value);
}
