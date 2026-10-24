import type { SearchFilters } from '@kb-chat/contracts';
import {
  FACET_TITLES,
  facetValueLabel,
  type FacetKey,
} from '@core/i18n/facet-labels.js';

/** "Assuntos: Cabala · Tipo de texto: Aula ou palestra" for the answer header, or "" without filters. */
export function describeFilters(filters: SearchFilters): string {
  return (Object.keys(filters) as FacetKey[])
    .flatMap((key) =>
      filters[key].map(
        (value) => `${FACET_TITLES[key]}: ${facetValueLabel(key, value)}`,
      ),
    )
    .join(' · ');
}
