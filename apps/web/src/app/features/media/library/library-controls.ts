import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
  output,
} from '@angular/core';
import {
  LIBRARY_SORTS,
  LISTENING_STATES,
  MEDIA_AUTHORSHIPS,
  type LibraryFacets,
  type LibraryFilters,
  type LibrarySort,
  type LibraryView,
  type Topic,
} from '@kb-chat/contracts';
import { AUTHORSHIP_LABELS } from '@core/i18n/facet-labels.js';
import { treeTitle } from '@core/topics/topic-tree.js';
import { MenuButton, type MenuOption } from '../menu-button.js';
import {
  SORT_LABELS,
  STATE_CHIP_LABELS,
  activeFiltersOf,
  toggled,
} from './library-labels.js';

/** A chip: its value, its words and whether it is on. */
interface Chip<T> {
  readonly value: T;
  readonly label: string;
  readonly pressed: boolean;
}

/**
 * "Todas"'s controls (screens.md T16, SL-13/15/16; audio only, video comes later): combinable
 * chips with aria-pressed, the
 * Autoria and Acervo choices, "Limpar filtros", the order (APG menu button) and the list or
 * grid view. A chip with nothing behind it is not shown, unless it is on.
 */
@Component({
  selector: 'app-library-controls',
  imports: [MenuButton],
  templateUrl: './library-controls.html',
  styleUrl: './library-controls.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class LibraryControls {
  readonly facets = input.required<LibraryFacets>();
  readonly filters = input.required<LibraryFilters>();
  readonly sort = input.required<LibrarySort>();
  readonly view = input.required<LibraryView>();
  /** The collections the person sees (the sidebar's list). */
  readonly topics = input<readonly Topic[]>([]);
  readonly filtersChange = output<LibraryFilters>();
  readonly sortChange = output<LibrarySort>();
  readonly viewChange = output<LibraryView>();

  protected readonly stateChips = computed(() => {
    const { states } = this.filters();
    return LISTENING_STATES.filter(
      (value) => this.facets().states.includes(value) || states.includes(value),
    ).map((value) => ({
      value,
      label: STATE_CHIP_LABELS[value](),
      pressed: states.includes(value),
    }));
  });
  protected readonly authorships = computed(() =>
    MEDIA_AUTHORSHIPS.filter((value) =>
      this.facets().authorships.includes(value),
    ).map((value) => ({ value, label: AUTHORSHIP_LABELS[value] })),
  );
  protected readonly showAuthorship = computed(
    () =>
      this.authorships().length > 1 || this.filters().authorships.length > 0,
  );
  protected readonly authorship = computed(
    () => this.filters().authorships[0] ?? '',
  );
  /** Collections holding media, each parent with its sub-collections (ADR 0028). */
  protected readonly topicOptions = computed(() => {
    const holding = new Set(this.facets().topics);
    const parents = new Set(
      this.topics()
        .filter((topic) => topic.parent !== null && holding.has(topic.slug))
        .map((topic) => topic.parent),
    );
    return this.topics()
      .filter((topic) => holding.has(topic.slug) || parents.has(topic.slug))
      .map((topic) => ({ value: topic.slug, label: treeTitle(topic) }));
  });
  protected readonly showTopics = computed(
    () => this.topicOptions().length > 1 || this.filters().topic !== null,
  );
  protected readonly active = computed(() => activeFiltersOf(this.filters()));
  protected readonly sortOptions = computed<readonly MenuOption[]>(() =>
    LIBRARY_SORTS.map((id) => ({
      id,
      label: SORT_LABELS[id](),
      checked: id === this.sort(),
    })),
  );
  protected readonly sortLabel = computed(
    () =>
      $localize`:@@library.sortBy:Ordenar: ${SORT_LABELS[this.sort()]()}:sort:`,
  );

  protected toggleState(value: (typeof LISTENING_STATES)[number]): void {
    const filters = this.filters();
    this.filtersChange.emit({
      ...filters,
      states: toggled(filters.states, value),
    });
  }

  protected chooseAuthorship(event: Event): void {
    const target = event.target;
    if (!(target instanceof HTMLSelectElement)) return;
    const value = MEDIA_AUTHORSHIPS.find((one) => one === target.value);
    this.filtersChange.emit({
      ...this.filters(),
      authorships: value ? [value] : [],
    });
  }

  protected chooseTopic(event: Event): void {
    if (!(event.target instanceof HTMLSelectElement)) return;
    const { value } = event.target;
    this.filtersChange.emit({ ...this.filters(), topic: value || null });
  }

  protected clear(): void {
    this.filtersChange.emit({
      states: [],
      authorships: [],
      topic: null,
    });
  }

  protected chooseSort(id: string): void {
    const sort = LIBRARY_SORTS.find((one) => one === id);
    if (sort) this.sortChange.emit(sort);
  }
}
