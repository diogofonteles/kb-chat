import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  computed,
  inject,
  input,
  linkedSignal,
  output,
  signal,
} from '@angular/core';
import type { ResultFacets, SearchFilters } from '@kb-chat/contracts';
import type { FacetKey } from '@core/i18n/facet-labels.js';
import {
  activeFilters,
  countActive,
  toFacetGroups,
  toggleFilter,
  type ActiveFilter,
  type FacetGroup,
  type FacetOption,
  type FacetValue,
} from './filter-model.js';

/** Options listed before "Ver todos" (UP-15: few choices at once). */
const VISIBLE_OPTIONS = 12;

/**
 * Facet chips over a result list (screens.md T2). Desktop: one popover per facet,
 * applied on each change. Mobile: one "Filtros" sheet with Aplicar/Cancelar (SL-21).
 */
@Component({
  selector: 'app-filter-bar',
  templateUrl: './filter-bar.html',
  styleUrl: './filter-bar.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    '(document:click)': 'closeOnOutsideClick($event)',
    '(document:keydown.escape)': 'closeAll()',
  },
})
export class FilterBar {
  private readonly host =
    inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;

  readonly facets = input.required<ResultFacets>();
  readonly filters = input.required<SearchFilters>();
  readonly hiddenOffTopic = input(0);
  readonly filtersChange = output<SearchFilters>();

  protected readonly openKey = signal<FacetKey | null>(null);
  protected readonly expanded = signal<ReadonlySet<FacetKey>>(new Set());
  protected readonly sheetOpen = signal(false);
  /** Mobile sheet selection, discarded on Cancelar and reset when the applied filters change. */
  protected readonly draft = linkedSignal(() => this.filters());

  protected readonly groups = computed(() =>
    toFacetGroups(this.facets(), this.filters()),
  );
  protected readonly draftGroups = computed(() =>
    toFacetGroups(this.facets(), this.draft()),
  );
  protected readonly active = computed(() => activeFilters(this.filters()));
  protected readonly activeCount = computed(() => countActive(this.filters()));

  protected visibleOptions(group: FacetGroup): readonly FacetOption[] {
    return this.expanded().has(group.key)
      ? group.options
      : group.options.slice(0, VISIBLE_OPTIONS);
  }

  protected hiddenOptions(group: FacetGroup): number {
    return this.expanded().has(group.key)
      ? 0
      : Math.max(0, group.options.length - VISIBLE_OPTIONS);
  }

  protected expand(key: FacetKey): void {
    this.expanded.update((keys) => new Set([...keys, key]));
  }

  protected togglePopover(key: FacetKey): void {
    this.openKey.update((open) => (open === key ? null : key));
  }

  protected toggle(key: FacetKey, value: FacetValue): void {
    this.filtersChange.emit(toggleFilter(this.filters(), key, value));
  }

  protected remove(filter: ActiveFilter): void {
    this.toggle(filter.key, filter.value);
  }

  protected toggleDraft(key: FacetKey, value: FacetValue): void {
    this.draft.update((filters) => toggleFilter(filters, key, value));
  }

  protected openSheet(): void {
    this.draft.set(this.filters());
    this.sheetOpen.set(true);
  }

  protected applySheet(): void {
    this.sheetOpen.set(false);
    this.filtersChange.emit(this.draft());
  }

  protected closeAll(): void {
    this.openKey.set(null);
    this.sheetOpen.set(false);
  }

  protected closeOnOutsideClick(event: MouseEvent): void {
    if (this.openKey() && !this.host.contains(event.target as Node))
      this.openKey.set(null);
  }
}
