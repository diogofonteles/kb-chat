import type {
  Authorship,
  ResultFacets,
  SearchFilters,
} from '@kb-chat/contracts';
import {
  AUTHORSHIP_LABELS,
  FACET_TITLES,
  facetValueLabel,
  type FacetKey,
  type FacetNames,
} from '@core/i18n/facet-labels.js';

/** Facets in display order; depth goes last because most documents share one level (screens.md). */
export const FACET_ORDER: readonly FacetKey[] = [
  'topics',
  'concepts',
  'genres',
  'relevances',
  'depths',
];

/** Every filter, the authorship control (KBC-020) included: what "remove a filter" offers. */
const FILTER_KEYS: readonly FacetKey[] = [...FACET_ORDER, 'authorships'];

export type FacetValue = string | number;

export interface FacetOption {
  readonly value: FacetValue;
  readonly label: string;
  readonly count: number;
  /** "12", or "12 · 3 faixas" for who sees subjects (KBC-070 BR-4). */
  readonly countText: string;
  readonly selected: boolean;
}

export interface FacetGroup {
  readonly key: FacetKey;
  readonly title: string;
  readonly options: readonly FacetOption[];
  readonly selectedCount: number;
}

export interface ActiveFilter {
  readonly key: FacetKey;
  readonly value: FacetValue;
  readonly label: string;
  readonly removeLabel: string;
}

const tracksText = (tracks: number): string =>
  tracks === 1
    ? $localize`:@@filters.tracksOne:1 faixa`
    : $localize`:@@filters.tracksMany:${tracks}:tracks: faixas`;

/** Documents and tracks apart; a subject only tracks have says just them. */
function countTextOf(count: number, tracks: number): string {
  if (tracks === 0) return String(count);
  return count === 0
    ? tracksText(tracks)
    : `${String(count)} · ${tracksText(tracks)}`;
}

const selectedValues = (
  filters: SearchFilters,
  key: FacetKey,
): readonly FacetValue[] => filters[key];

/** One facet's options: values with results plus any selected value that dropped to zero. */
interface GroupSource {
  readonly facets: ResultFacets;
  readonly filters: SearchFilters;
  readonly topicNames: ReadonlyMap<string, string>;
}

interface CountedValue {
  readonly value: FacetValue;
  readonly count: number;
  readonly tracks?: number;
}

function toFacetGroup(
  key: FacetKey,
  { facets, filters, topicNames }: GroupSource,
): FacetGroup {
  const selected = selectedValues(filters, key);
  const option = (
    value: FacetValue,
    count: number,
    tracks = 0,
  ): FacetOption => ({
    value,
    count,
    countText: countTextOf(count, tracks),
    label: facetValueLabel(key, value, { topicNames }),
    selected: selected.includes(value),
  });
  const counted = (facets[key] as readonly CountedValue[]).map(
    ({ value, count, tracks }) => option(value, count, tracks),
  );
  const missing = selected
    .filter((value) => !counted.some((one) => one.value === value))
    .map((value) => option(value, 0));
  return {
    key,
    title: FACET_TITLES[key],
    options: [...counted, ...missing],
    selectedCount: selected.length,
  };
}

/** Options shown for each facet, in display order. */
export function toFacetGroups(
  facets: ResultFacets,
  filters: SearchFilters,
  topicNames: ReadonlyMap<string, string> = new Map(),
): FacetGroup[] {
  const source = { facets, filters, topicNames };
  return FACET_ORDER.map((key) => toFacetGroup(key, source)).filter(shown);
}

/** A "Sub-acervo" with one collection only has nothing to choose (KBC-048 FR-4). */
const shown = (group: FacetGroup): boolean =>
  group.key === 'topics'
    ? group.options.length > 1 || group.selectedCount > 0
    : group.options.length > 0;

/**
 * Active filters as removable chips; with an application order ("facet:value" keys,
 * newest last), the most recently applied comes first (KBC-002 AC-11).
 */
export function activeFilters(
  filters: SearchFilters,
  order: readonly string[] = [],
  names: FacetNames = {},
): ActiveFilter[] {
  const active = FILTER_KEYS.flatMap((key) =>
    selectedValues(filters, key).map((value) => {
      const label = `${FACET_TITLES[key]}: ${facetValueLabel(key, value, names)}`;
      return {
        key,
        value,
        label,
        removeLabel: $localize`:@@filters.remove:Remover ${label}:label:`,
      };
    }),
  );
  const rank = (filter: ActiveFilter): number =>
    order.indexOf(`${filter.key}:${filter.value}`);
  return order.length === 0
    ? active
    : [...active].sort((a, b) => rank(b) - rank(a));
}

/** Returns new filters with the value added or removed (filters are never mutated). */
export function toggleFilter(
  filters: SearchFilters,
  key: FacetKey,
  value: FacetValue,
): SearchFilters {
  const current = selectedValues(filters, key);
  const next = current.includes(value)
    ? current.filter((v) => v !== value)
    : [...current, value];
  return { ...filters, [key]: next } as SearchFilters;
}

export const countActive = (filters: SearchFilters): number =>
  FACET_ORDER.reduce((sum, key) => sum + filters[key].length, 0);

/** The groups the authorship control offers (KBC-020): null is "Todos". */
const AUTHORSHIP_CHOICES = ['mestre-laercio', 'outros-autores'] as const;

export interface AuthorshipOption {
  readonly value: Authorship | null;
  readonly label: string;
  readonly count: number;
  readonly selected: boolean;
  /** Mestre Laércio carries its mark (BR-3: not color only). */
  readonly mestre: boolean;
}

/** The selected group, or null for "Todos" (any other selection also reads as "Todos"). */
export function selectedAuthorship(filters: SearchFilters): Authorship | null {
  const [only, ...rest] = filters.authorships;
  return only && rest.length === 0 ? only : null;
}

/** "Todos (10) · Mestre Laércio (6) · Outros autores (3)": Todos counts every group. */
export function authorshipOptions(
  facets: ResultFacets,
  filters: SearchFilters,
  /** The collection's labels: its main author's name for the main group (KBC-049). */
  labels: Record<Authorship, string> = AUTHORSHIP_LABELS,
): AuthorshipOption[] {
  const selected = selectedAuthorship(filters);
  const countOf = (value: Authorship): number =>
    facets.authorships.find((option) => option.value === value)?.count ?? 0;
  const total = facets.authorships.reduce((sum, { count }) => sum + count, 0);
  return [
    {
      value: null,
      label: $localize`:@@authorship.all:Todos`,
      count: total,
      selected: selected === null,
      mestre: false,
    },
    ...AUTHORSHIP_CHOICES.map((value) => ({
      value,
      label: labels[value],
      count: countOf(value),
      selected: selected === value,
      mestre: value === 'mestre-laercio',
    })),
  ];
}

/** New filters with one authorship group, or every group for null (filters are never mutated). */
export const withAuthorship = (
  filters: SearchFilters,
  value: Authorship | null,
): SearchFilters => ({ ...filters, authorships: value ? [value] : [] });
