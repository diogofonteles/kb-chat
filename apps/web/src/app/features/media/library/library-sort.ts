import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
  output,
} from '@angular/core';
import {
  LIBRARY_SORTS,
  LIBRARY_VIEWS,
  type LibrarySort,
  type LibraryView,
} from '@kb-chat/contracts';
import { UiIcon } from '@ui/icon.js';
import { MenuButton, type MenuOption } from '../menu-button.js';
import { SORT_LABELS } from './library-labels.js';

/**
 * How the list shows (media-library-sort, "Ver como"): the account's two views and
 * "Compacta", the list without covers, kept in this browser (a density of the list).
 */
export type LibraryDisplay = LibraryView | 'compact';
const DISPLAYS: readonly LibraryDisplay[] = ['compact', ...LIBRARY_VIEWS];
const DISPLAY_ICONS = {
  compact: 'drag',
  list: 'list',
  grid: 'grid',
} as const satisfies Record<LibraryDisplay, string>;

const CLEAR_RECENTS = 'clear-recents';

/** The phone's last item: an action among the choices, set apart. */
const clearRecentsOption = (): MenuOption => ({
  id: CLEAR_RECENTS,
  label: $localize`:@@library.clearRecents:Limpar recentes`,
  icon: 'close',
  divider: true,
  action: true,
});

/** A view's item in the menu carries this before its name. */
const VIEW_PREFIX = 'view:';
const VIEW_LABELS: Record<LibraryDisplay, () => string> = {
  compact: () => $localize`:@@library.viewCompact:Compacta`,
  list: () => $localize`:@@library.viewList:Lista`,
  grid: () => $localize`:@@library.viewGrid:Grade`,
};

/**
 * "Ordenar por" and "Ver como" in one menu (KBC-128 FR-3, media-library-sort): its trigger is
 * the order in words and the view's icon, at the end of the action bar on a desktop and on
 * the line above the list on a phone (with the order's icon first, media-library@mobile).
 * A sheet on a phone.
 */
@Component({
  selector: 'app-library-sort',
  imports: [MenuButton, UiIcon],
  template: `
    <app-menu-button
      kind="choice"
      class="sort"
      [label]="sortLabel()"
      menuLabel="Ordenar e ver como"
      i18n-menuLabel="@@library.sortAndView"
      [options]="sortOptions()"
      [align]="align()"
      (chosen)="choose($event)"
    >
      @if (phone()) {
        <ui-icon name="sort" [size]="16" />
      }
      <span class="words">{{ (phone() && summary()) || sortName() }}</span>
      @if (!phone()) {
        <ui-icon [name]="icons[view()]" [size]="18" />
      }
    </app-menu-button>
  `,
  styles: `
    :host {
      display: inline-flex;
    }

    app-menu-button {
      --menu-trigger-size: var(--text-sm);
      --menu-trigger-padding: var(--space-2);
      --menu-trigger-height: 2rem;
    }

    :host(.phone) app-menu-button {
      --menu-trigger-color: var(--color-text);
      --menu-trigger-weight: 500;
      --menu-trigger-size: var(--text-meta);
      --menu-trigger-padding: 0;
      --menu-trigger-height: var(--target);
    }

    .words {
      white-space: nowrap;
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { '[class.phone]': 'phone()' },
})
export class LibrarySortMenu {
  readonly sort = input.required<LibrarySort>();
  readonly view = input.required<LibraryDisplay>();
  /** The phone's line above the list: the order's icon first, the view has its own button. */
  readonly phone = input(false);
  readonly align = input<'start' | 'end'>('end');
  /**
   * A phone with a filter on says how much is left in the order's place, "5 mídias · 3 min"
   * (media-library-chip@mobile, -author@mobile); the menu keeps its name ("Ordenar: …").
   */
  readonly summary = input('');
  readonly sortChange = output<LibrarySort>();
  readonly viewChange = output<LibraryDisplay>();
  /** On a phone, "Limpar recentes" under the choices (the header's ⋯ has no place there). */
  readonly clearRecents = input(false);
  readonly recentsCleared = output();
  protected readonly icons = DISPLAY_ICONS;

  protected readonly sortOptions = computed<readonly MenuOption[]>(() => {
    const sortGroup = $localize`:@@library.sortGroup:Ordenar por`;
    const viewGroup = $localize`:@@library.viewGroup:Ver como`;
    return [
      ...LIBRARY_SORTS.map((id) => ({
        id,
        label: SORT_LABELS[id](),
        checked: id === this.sort(),
        group: sortGroup,
      })),
      ...DISPLAYS.map((view) => ({
        id: `${VIEW_PREFIX}${view}`,
        label: VIEW_LABELS[view](),
        icon: DISPLAY_ICONS[view],
        checked: view === this.view(),
        group: viewGroup,
        // On a phone's sheet the three are pills in one row (media-library-sort@mobile).
        pill: true,
      })),
      ...(this.clearRecents() ? [clearRecentsOption()] : []),
    ];
  });
  protected readonly sortName = computed(() => SORT_LABELS[this.sort()]());
  protected readonly sortLabel = computed(
    () =>
      $localize`:@@library.sortBy:Ordenar: ${SORT_LABELS[this.sort()]()}:sort:`,
  );

  protected choose(id: string): void {
    if (id === CLEAR_RECENTS) {
      this.recentsCleared.emit();
      return;
    }
    const view = DISPLAYS.find((one) => `${VIEW_PREFIX}${one}` === id);
    if (view) {
      if (view !== this.view()) this.viewChange.emit(view);
      return;
    }
    const sort = LIBRARY_SORTS.find((one) => one === id);
    if (sort) this.sortChange.emit(sort);
  }
}
