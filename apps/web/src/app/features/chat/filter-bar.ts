import { injectAuthorshipLabels } from '@features/authorship/authorship-labels.js';
import {
  ChangeDetectionStrategy,
  Component,
  DOCUMENT,
  ElementRef,
  Injector,
  afterNextRender,
  computed,
  inject,
  input,
  linkedSignal,
  output,
  signal,
  viewChild,
} from '@angular/core';
import type {
  Authorship,
  ResultFacets,
  SearchFilters,
} from '@kb-chat/contracts';
import type { FacetKey } from '@core/i18n/facet-labels.js';
import {
  activeFilters,
  authorshipOptions,
  countActive,
  selectedAuthorship,
  toFacetGroups,
  toggleFilter,
  withAuthorship,
  type ActiveFilter,
  type FacetGroup,
  type FacetOption,
  type FacetValue,
} from './filter-model.js';

/** Options listed before "Ver todos" (UP-15: few choices at once). */
const VISIBLE_OPTIONS = 12;
const MOBILE_QUERY = '(max-width: 1023px)';
/** Each bar's authorship radios need a group name of their own (one bar per message). */
let nextBarId = 0;

/**
 * Facet chips over a result list (screens.md T2). Desktop: one popover per facet,
 * applied on each change. Mobile: the chips scroll and open one "Filtros" sheet with
 * Aplicar/Cancelar (SL-21), a native modal dialog that traps and restores focus.
 */
@Component({
  selector: 'app-filter-bar',
  templateUrl: './filter-bar.html',
  styleUrl: './filter-bar.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { '(document:click)': 'closeOnOutsideClick($event)' },
})
export class FilterBar {
  private readonly host =
    inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;
  private readonly view = inject(DOCUMENT).defaultView;
  private readonly injector = inject(Injector);
  private readonly sheet = viewChild<ElementRef<HTMLDialogElement>>('sheet');
  private readonly sheetButton =
    viewChild.required<ElementRef<HTMLButtonElement>>('sheetButton');

  readonly facets = input.required<ResultFacets>();
  readonly filters = input.required<SearchFilters>();
  readonly hiddenOffTopic = input(0);
  /** Application order of the active filters ("facet:value", newest last). */
  readonly order = input<readonly string[]>([]);
  /** Names of the collections a parent's search spans (the "Sub-acervo" filter, KBC-048). */
  readonly topicNames = input<ReadonlyMap<string, string>>(new Map());
  readonly filtersChange = output<SearchFilters>();

  private readonly labels = injectAuthorshipLabels();
  protected readonly openKey = signal<FacetKey | null>(null);
  protected readonly expanded = signal<ReadonlySet<FacetKey>>(new Set());
  protected readonly sheetOpen = signal(false);
  /** Mobile sheet selection, discarded on Cancelar and reset when the applied filters change. */
  protected readonly draft = linkedSignal(() => this.filters());

  protected readonly groups = computed(() =>
    toFacetGroups(this.facets(), this.filters(), this.topicNames()),
  );
  protected readonly draftGroups = computed(() =>
    toFacetGroups(this.facets(), this.draft(), this.topicNames()),
  );
  /**
   * The authorship control shows a single choice (KBC-020): no removable chip repeats it.
   * Several groups (API or an edited saved search) read as "Todos" there, so they stay chips.
   */
  protected readonly active = computed(() => {
    const single = selectedAuthorship(this.filters()) !== null;
    return activeFilters(this.filters(), this.order(), {
      topicNames: this.topicNames(),
      authorships: this.labels(),
    }).filter((filter) => !(single && filter.key === 'authorships'));
  });
  protected readonly authorships = computed(() =>
    authorshipOptions(this.facets(), this.filters(), this.labels()),
  );
  protected readonly barId = `filters-${nextBarId++}`;
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

  /** Desktop opens the facet's popover; phones open the sheet (no popovers at that width). */
  protected openFacet(key: FacetKey): void {
    if (this.isPhone()) {
      this.openSheet(key);
      return;
    }
    this.openKey.update((open) => (open === key ? null : key));
  }

  protected toggle(key: FacetKey, value: FacetValue): void {
    this.filtersChange.emit(toggleFilter(this.filters(), key, value));
  }

  /** KBC-020: one group, or every group ("Todos"), applied at once on every width. */
  protected chooseAuthorship(value: Authorship | null): void {
    this.filtersChange.emit(withAuthorship(this.filters(), value));
  }

  protected remove(filter: ActiveFilter): void {
    this.toggle(filter.key, filter.value);
    // The removed chip disappears: keep focus on its facet (desktop) or on "Filtros" (phones).
    const facetChip = this.host.querySelector<HTMLElement>(
      `[data-facet="${filter.key}"]`,
    );
    const target =
      this.isPhone() || !facetChip
        ? this.sheetButton().nativeElement
        : facetChip;
    target.focus();
  }

  private isPhone(): boolean {
    return this.view?.matchMedia?.(MOBILE_QUERY).matches ?? false;
  }

  protected toggleDraft(key: FacetKey, value: FacetValue): void {
    this.draft.update((filters) => toggleFilter(filters, key, value));
  }

  protected openSheet(facet?: FacetKey): void {
    this.draft.set(this.filters());
    this.sheetOpen.set(true);
    // showModal() makes the rest of the page inert, traps focus and closes on Escape;
    // opened from a chip, the sheet starts on that facet's first option.
    afterNextRender(() => this.showSheet(facet), { injector: this.injector });
  }

  private showSheet(facet: FacetKey | undefined): void {
    const dialog = this.sheet()?.nativeElement;
    dialog?.showModal();
    if (!facet) return;
    const first = dialog?.querySelector<HTMLInputElement>(
      `[data-sheet-facet="${facet}"] input`,
    );
    first?.focus();
    first?.scrollIntoView({ block: 'start' });
  }

  protected applySheet(): void {
    this.filtersChange.emit(this.draft());
    this.sheet()?.nativeElement.close();
  }

  protected cancelSheet(): void {
    this.sheet()?.nativeElement.close();
  }

  /** Native "close" (Aplicar, Cancelar or Escape): unmount and return focus to "Filtros". */
  protected sheetClosed(): void {
    this.sheetOpen.set(false);
    this.sheetButton().nativeElement.focus();
  }

  protected closePopover(chip: HTMLElement): void {
    if (!this.openKey()) return;
    this.openKey.set(null);
    chip.focus();
  }

  /** Tabbing out of a facet (chip + popover) closes its popover (QA-3). */
  protected closeOnFocusOut(event: FocusEvent, facet: HTMLElement): void {
    const next = event.relatedTarget as Node | null;
    if (next && !facet.contains(next)) this.openKey.set(null);
  }

  protected closeOnOutsideClick(event: MouseEvent): void {
    if (this.openKey() && !this.host.contains(event.target as Node))
      this.openKey.set(null);
  }
}
