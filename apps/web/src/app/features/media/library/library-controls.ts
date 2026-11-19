import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
  output,
} from '@angular/core';
import {
  LISTENING_STATES,
  NO_AUTHOR,
  type LibraryFacets,
  type LibraryFilters,
  type ListeningState,
  type Topic,
} from '@kb-chat/contracts';
import { UiButton, UiChip } from '@ui/button.js';
import { UiIcon } from '@ui/icon.js';
import { MenuButton, type MenuOption } from '../menu-button.js';
import {
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
 * The library's filters (screens.md T16, SL-13/15/16; v2 media-library "filtros"): "Todas",
 * the state chips with aria-pressed, "Autoria ▾" (a menu; once chosen, the author's name
 * with ✕), "Assunto ▾" likewise and "Limpar filtros". The collection is not here: it is the
 * page's scope, named in its header (owner, 2026-11-19). "Ouvidas" shows only when something is heard; the order and the view are
 * the action bar's (LibrarySortMenu).
 */
@Component({
  selector: 'app-library-controls',
  imports: [MenuButton, UiButton, UiChip, UiIcon],
  templateUrl: './library-controls.html',
  styleUrl: './library-controls.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class LibraryControls {
  readonly facets = input.required<LibraryFacets>();
  readonly filters = input.required<LibraryFilters>();
  /** The collections the person sees (the sidebar's list). */
  readonly topics = input<readonly Topic[]>([]);
  /** A search is on (KBC-096): only the collection, the rest out of the results' way. */
  readonly compact = input(false);
  /** A search is on (the results' own controls). */
  readonly searching = input(false);
  readonly filtersChange = output<FilterChange>();

  protected readonly stateChips = computed<Chip<ListeningState>[]>(() => {
    if (this.compact()) return [];
    const { states } = this.filters();
    // "Não ouvidas" and "Em andamento" always (the frame's row); "Ouvidas" once there is one.
    return LISTENING_STATES.filter(
      (value) =>
        value !== 'heard' ||
        this.facets().states.includes(value) ||
        states.includes(value),
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
  /** Always beside the states, as in every v2 frame (an empty library's included). */
  protected readonly showAuthorship = computed(() => !this.compact());
  protected readonly authorship = computed(
    () => this.filters().authors[0] ?? '',
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
  /** No state and no author chosen: "Todas" is the pressed chip. */
  protected readonly noListFilter = computed(
    () =>
      this.filters().states.length === 0 && this.filters().authors.length === 0,
  );
  /** "Autoria ▾"'s menu: every author, the main one first, then "Outros autores". */
  protected readonly authorOptions = computed<readonly MenuOption[]>(() => {
    const options = this.authors().map((one) => ({
      id: one.value,
      label: one.label,
      checked: one.value === this.authorship(),
    }));
    // Nothing to tell apart yet (an empty library): the one choice is every authorship.
    return options.length > 0
      ? options
      : [
          {
            id: '',
            label: $localize`:@@library.allAuthorships:Todas as autorias`,
            checked: true,
          },
        ];
  });

  protected readonly authorshipName = computed(() => {
    const chosen = this.authorship();
    if (!chosen) return '';
    if (chosen === NO_AUTHOR)
      return $localize`:@@authorship.others:Outros autores`;
    const named = this.facets().authors.find((one) => one.slug === chosen);
    return named?.name ?? chosen;
  });
  protected readonly clearAuthorshipLabel = computed(
    () =>
      $localize`:@@library.clearAuthorship:Tirar o filtro de autoria: ${this.authorshipName()}:name:`,
  );
  protected readonly subjectMenu = computed<readonly MenuOption[]>(() =>
    this.subjectOptions().map((one) => ({
      id: one.key,
      label: one.name,
      checked: one.key === this.filters().subject,
    })),
  );
  protected readonly subjectName = computed(() => {
    const chosen = this.filters().subject;
    if (chosen === null) return '';
    return this.subjectOptions().find((one) => one.key === chosen)?.name ?? '';
  });
  protected readonly clearSubjectLabel = computed(
    () =>
      $localize`:@@library.clearSubject:Tirar o filtro de assunto: ${this.subjectName()}:name:`,
  );
  /** "Todas": no state, no author (the collection stays). */
  protected showAll(): void {
    if (!this.noListFilter()) this.filtersChange.emit({ kind: 'all' });
  }

  protected toggleState(value: (typeof LISTENING_STATES)[number]): void {
    this.filtersChange.emit({ kind: 'toggle-state', state: value });
  }

  protected chooseAuthorship(id: string): void {
    const value = this.authors().find((one) => one.value === id);
    this.filtersChange.emit({ kind: 'author', author: value?.value ?? null });
  }

  protected chooseSubject(id: string): void {
    this.filtersChange.emit({ kind: 'subject', subject: id || null });
  }

  protected clear(): void {
    this.filtersChange.emit({ kind: 'clear' });
  }
}
