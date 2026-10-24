import type { ResultFacets, SearchFilters } from '@kb-chat/contracts';
import {
  FACET_TITLES,
  facetValueLabel,
  type FacetKey,
} from '@core/i18n/facet-labels.js';

/** Facets in display order; depth goes last because most documents share one level (screens.md). */
export const FACET_ORDER: readonly FacetKey[] = [
  'concepts',
  'genres',
  'relevances',
  'depths',
];

export type FacetValue = string | number;

export interface FacetOption {
  readonly value: FacetValue;
  readonly label: string;
  readonly count: number;
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

const selectedValues = (
  filters: SearchFilters,
  key: FacetKey,
): readonly FacetValue[] => filters[key];

/** Options shown for each facet: values with results plus any selected value that dropped to zero. */
export function toFacetGroups(
  facets: ResultFacets,
  filters: SearchFilters,
): FacetGroup[] {
  return FACET_ORDER.map((key) => {
    const selected = selectedValues(filters, key);
    const counted = (
      facets[key] as readonly { value: FacetValue; count: number }[]
    ).map(({ value, count }) => ({
      value,
      count,
      label: facetValueLabel(key, value),
      selected: selected.includes(value),
    }));
    const missing = selected
      .filter((value) => !counted.some((option) => option.value === value))
      .map((value) => ({
        value,
        count: 0,
        label: facetValueLabel(key, value),
        selected: true,
      }));
    return {
      key,
      title: FACET_TITLES[key],
      options: [...counted, ...missing],
      selectedCount: selected.length,
    };
  }).filter((group) => group.options.length > 0);
}

export function activeFilters(filters: SearchFilters): ActiveFilter[] {
  return FACET_ORDER.flatMap((key) =>
    selectedValues(filters, key).map((value) => {
      const label = `${FACET_TITLES[key]}: ${facetValueLabel(key, value)}`;
      return {
        key,
        value,
        label,
        removeLabel: $localize`:@@filters.remove:Remover ${label}:label:`,
      };
    }),
  );
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
