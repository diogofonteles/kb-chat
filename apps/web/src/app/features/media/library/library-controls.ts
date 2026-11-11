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
  NO_AUTHOR,
  type LibraryFacets,
  type LibraryFilters,
  type LibrarySort,
  type LibraryView,
  type ListeningState,
  type Topic,
} from '@kb-chat/contracts';
import { treeTitle } from '@core/topics/topic-tree.js';
import { MenuButton, type MenuOption } from '../menu-button.js';
import {
  SORT_LABELS,
  STATE_CHIP_LABELS,
  activeFiltersOf,
  type FilterChange,
} from './library-labels.js';

/** A chip: its value, its words and whether it is on. */
interface Chip<T> {
  readonly value: T;
  readonly label: string;
  readonly pressed: boolean;
}

/**
 * "Todas"'s controls (screens.md T16, SL-13/15/16; audio only, video comes later): the
 * state chips with aria-pressed, the Autoria and Acervo choices, "Limpar filtros", the order (APG menu button) and the list or
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
  /** A search is on (KBC-096): only the collection, the rest out of the results' way. */
  readonly compact = input(false);
  readonly filtersChange = output<FilterChange>();
  readonly sortChange = output<LibrarySort>();
  readonly viewChange = output<LibraryView>();

  protected readonly stateChips = computed<Chip<ListeningState>[]>(() => {
    if (this.compact()) return [];
    const { states } = this.filters();
    return LISTENING_STATES.filter(
      (value) => this.facets().states.includes(value) || states.includes(value),
    ).map((value) => ({
      value,
      label: STATE_CHIP_LABELS[value](),
      pressed: states.includes(value),
    }));
  });
  /** The authors with media (KBC-049): the main one first, then "Outros autores". */
  protected readonly authors = computed(() => {
    const { authors, otherAuthors } = this.facets();
    const named = authors.map((author) => ({
      value: author.slug,
      // A native option reads its symbols aloud: the text says it instead of ✦.
      label: author.main
        ? $localize`:@@media.authorFilter.main:${author.name}:name:, principal`
        : author.name,
    }));
    return otherAuthors
      ? [
          ...named,
          {
            value: NO_AUTHOR,
            label: $localize`:@@authorship.others:Outros autores`,
          },
        ]
      : named;
  });
  protected readonly showAuthorship = computed(
    () =>
      !this.compact() &&
      (this.authors().length > 1 || this.filters().authors.length > 0),
  );
  protected readonly authorship = computed(
    () => this.filters().authors[0] ?? '',
  );
  /** Collections holding media, each parent with its sub-collections (ADR 0028). */
  protected readonly topicOptions = computed(() => {
    const holding = new Set(this.facets().topics);
    // The one in force stays on the list, even with no media: else the field would lie.
    const chosen = this.filters().topic;
    if (chosen) holding.add(chosen);
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
  /** The subjects of the tracks in sight; a chosen one that left stays, to be cleared. */
  protected readonly subjectOptions = computed(() => {
    const { subjects } = this.facets();
    const chosen = this.filters().subject;
    const known = subjects.some((one) => one.key === chosen);
    if (chosen === null || known) return subjects;
    const name = $localize`:@@library.subjectGone:Assunto indisponível`;
    return [...subjects, { key: chosen, name }];
  });
  protected readonly showSubjects = computed(
    () => !this.compact() && this.subjectOptions().length > 0,
  );
  protected readonly active = computed(() => activeFiltersOf(this.filters()));
  /**
   * Filters in force with no control on screen during a search (KBC-096 R5): Acervo stays on
   * screen, and the collection is not counted as a filter (KBC-091).
   */
  protected readonly hiddenActive = this.active;
  protected readonly hiddenText = computed(() => {
    const count = this.hiddenActive();
    return count === 1
      ? $localize`:@@library.hiddenFilter:1 filtro em uso`
      : $localize`:@@library.hiddenFilters:${count}:count: filtros em uso`;
  });
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
    this.filtersChange.emit({ kind: 'toggle-state', state: value });
  }

  protected chooseAuthorship(event: Event): void {
    const target = event.target;
    if (!(target instanceof HTMLSelectElement)) return;
    const value = this.authors().find((one) => one.value === target.value);
    this.filtersChange.emit({ kind: 'author', author: value?.value ?? null });
  }

  protected chooseTopic(event: Event): void {
    if (!(event.target instanceof HTMLSelectElement)) return;
    const { value } = event.target;
    this.filtersChange.emit({ kind: 'topic', topic: value || null });
  }

  protected chooseSubject(event: Event): void {
    if (!(event.target instanceof HTMLSelectElement)) return;
    const { value } = event.target;
    this.filtersChange.emit({ kind: 'subject', subject: value || null });
  }

  protected clear(): void {
    this.filtersChange.emit({ kind: 'clear' });
  }

  protected chooseSort(id: string): void {
    const sort = LIBRARY_SORTS.find((one) => one === id);
    if (sort) this.sortChange.emit(sort);
  }
}
