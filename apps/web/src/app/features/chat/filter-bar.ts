import { NgTemplateOutlet } from '@angular/common';
import { injectAuthorshipLabels } from '@features/authorship/authorship-labels.js';
import { UiBanner } from '@ui/banner.js';
import { UiButton } from '@ui/button.js';
import { UiIcon } from '@ui/icon.js';
import { UiOverlay } from '@ui/overlay.js';
import { NO_FILTERS } from './chat-message.js';
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
  SearchHit,
} from '@kb-chat/contracts';
import type { FacetKey } from '@core/i18n/facet-labels.js';
import {
  activeFilters,
  authorshipOptions,
  countActive,
  draftResultCount,
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
 * Aplicar/Cancelar (SL-21), a native modal dialog that traps and restores focus. v2
 * (KBC-126 FR-3): the authorship as segmented chips with their counts, the facets as chips
 * whose popover lives in the top layer (D5), the active ones with ✕ and "Limpar filtros",
 * the hidden off-topic results in a banner with "Mostrar", and "Ver N resultados" in the
 * sheet.
 */
@Component({
  selector: 'app-filter-bar',
  imports: [NgTemplateOutlet, UiBanner, UiButton, UiIcon, UiOverlay],
  templateUrl: './filter-bar.html',
  styleUrl: './filter-bar.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    '(document:click)': 'closeOnOutsideClick($event)',
    // Safari leaves the focus on the page when a checkbox is clicked: Escape still closes.
    '(document:keydown.escape)': 'closeOnEscape()',
  },
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
  /** The results the applied filters show: what the sheet offers while unchanged. */
  readonly total = input(0);
  /** The results on screen, to count a narrower selection exactly ("Ver 2 resultados"). */
  readonly items = input<readonly SearchHit[]>([]);
  /** Application order of the active filters ("facet:value", newest last). */
  readonly order = input<readonly string[]>([]);
  /** Names of the collections a parent's search spans (the "Sub-acervo" filter, KBC-048). */
  readonly topicNames = input<ReadonlyMap<string, string>>(new Map());
  readonly filtersChange = output<SearchFilters>();

  private readonly labels = injectAuthorshipLabels();
  protected readonly openKey = signal<FacetKey | null>(null);
  protected readonly expanded = signal<ReadonlySet<FacetKey>>(new Set());
  protected readonly sheetOpen = signal(false);
  /**
   * A phone's facet chip opens a sheet of that facet alone (chat-results-filter-popover
   * @mobile: its title, its options and "Aplicar"); "Filtros" opens them all.
   */
  protected readonly sheetFacet = signal<FacetKey | null>(null);
  private sheetTrigger: HTMLElement | null = null;
  /** Mobile sheet selection, discarded on Cancelar and reset when the applied filters change. */
  protected readonly draft = linkedSignal(() => this.filters());

  protected readonly groups = computed(() =>
    toFacetGroups(this.facets(), this.filters(), this.topicNames()),
  );
  protected readonly draftGroups = computed(() =>
    toFacetGroups(this.facets(), this.draft(), this.topicNames()),
  );
  /** The sheet's groups: the one its chip opened, or every one from "Filtros". */
  protected readonly sheetGroup = computed(
    () => this.draftGroups().find((g) => g.key === this.sheetFacet()) ?? null,
  );
  protected readonly sheetGroups = computed(() => {
    const only = this.sheetGroup();
    return only ? [only] : this.draftGroups();
  });
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
  /** The sheet's "Autoria" (filterSections): the draft's choice, applied with the rest. */
  protected readonly draftAuthorships = computed(() =>
    authorshipOptions(this.facets(), this.draft(), this.labels()),
  );
  protected readonly barId = `filters-${nextBarId++}`;
  protected readonly activeCount = computed(() => countActive(this.filters()));
  protected readonly draftCount = computed(() =>
    draftResultCount({
      facets: this.facets(),
      applied: this.filters(),
      draft: this.draft(),
      total: this.total(),
      items: this.items(),
    }),
  );

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
  protected openFacet(key: FacetKey, chip?: HTMLElement): void {
    if (this.isPhone()) {
      this.openSheet(key, chip);
      return;
    }
    // subjectsPopover: the ticks wait for "Aplicar" (the list behind does not change yet).
    this.draft.set(this.filters());
    this.openKey.update((open) => (open === key ? null : key));
  }

  /** The popover's group as the draft has it (its ticks before "Aplicar"). */
  protected draftGroup(key: FacetKey): FacetGroup | undefined {
    return this.draftGroups().find((group) => group.key === key);
  }

  /** "Aplicar" in a facet's popover: its ticks apply, and the popover closes. */
  protected applyPopover(chip: HTMLElement): void {
    const draft = this.draft();
    if (JSON.stringify(draft) !== JSON.stringify(this.filters()))
      this.filtersChange.emit(draft);
    this.closePopover(chip);
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

  /** "Limpar" in a facet's popover: that facet's ticks go (applied with "Aplicar"). */
  protected clearFacet(key: FacetKey, chip: HTMLElement): void {
    this.draft.update((filters) => ({ ...filters, [key]: [] }));
    chip.focus();
  }

  /** The sheet's "Autoria" radios: one group, or "Todos", in the draft. */
  protected chooseDraftAuthorship(value: Authorship | null): void {
    this.draft.update((filters) => withAuthorship(filters, value));
  }

  /** "Limpar filtros": every filter goes; the focus stays on the first facet's chip. */
  protected clearAll(): void {
    this.filtersChange.emit(NO_FILTERS);
    const first = this.host.querySelector<HTMLElement>('[data-facet]');
    (this.isPhone() || !first
      ? this.sheetButton().nativeElement
      : first
    ).focus();
  }

  /** "Mostrar" on the hidden off-topic results: the "Fora do tema" link filter brings them. */
  protected showOffTopic(): void {
    if (this.filters().relevances.includes('off_topic')) return;
    this.toggle('relevances', 'off_topic');
  }

  private isPhone(): boolean {
    return this.view?.matchMedia?.(MOBILE_QUERY).matches ?? false;
  }

  protected toggleDraft(key: FacetKey, value: FacetValue): void {
    this.draft.update((filters) => toggleFilter(filters, key, value));
  }

  protected openSheet(facet?: FacetKey, trigger?: HTMLElement): void {
    this.draft.set(this.filters());
    this.sheetFacet.set(facet ?? null);
    this.sheetTrigger = trigger ?? null;
    this.sheetOpen.set(true);
    // showModal() makes the rest of the page inert, traps focus and closes on Escape;
    // opened from a chip, the sheet starts on that facet's first option.
    afterNextRender(() => this.showSheet(facet), { injector: this.injector });
  }

  private showSheet(facet: FacetKey | undefined): void {
    const dialog = this.sheet()?.nativeElement;
    dialog?.showModal();
    // A folded facet with a filter on opens with the sheet (it stays as the person leaves it).
    dialog
      ?.querySelectorAll<HTMLDetailsElement>('details.sheet-facet')
      .forEach((facetBox) => {
        if (facetBox.querySelector('input:checked')) facetBox.open = true;
      });
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
    this.sheetFacet.set(null);
    (this.sheetTrigger ?? this.sheetButton().nativeElement).focus();
    this.sheetTrigger = null;
  }

  /** "Limpar" in the sheet's head: no filter in the draft (applied with "Ver resultados"). */
  protected clearDraft(): void {
    this.draft.set(NO_FILTERS);
  }

  /** A tap on the backdrop (the dialog itself, outside its content) cancels, as Escape does. */
  protected backdropTapped(event: MouseEvent): void {
    if (event.target === event.currentTarget) this.cancelSheet();
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

  protected closeOnEscape(): void {
    const key = this.openKey();
    if (!key) return;
    const chip = this.host.querySelector<HTMLElement>(`[data-facet="${key}"]`);
    this.openKey.set(null);
    chip?.focus();
  }

  protected closeOnOutsideClick(event: MouseEvent): void {
    if (this.openKey() && !this.host.contains(event.target as Node))
      this.openKey.set(null);
  }
}
