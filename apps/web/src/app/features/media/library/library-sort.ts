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

/** A view's item in the menu carries this before its name. */
const VIEW_PREFIX = 'view:';
const VIEW_LABELS: Record<LibraryView, () => string> = {
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
        <ui-icon [name]="view() === 'grid' ? 'grid' : 'list'" [size]="18" />
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
  readonly view = input.required<LibraryView>();
  /** The phone's line above the list: the order's icon first, the view has its own button. */
  readonly phone = input(false);
  readonly align = input<'start' | 'end'>('end');
  /**
   * A phone with a filter on says how much is left in the order's place, "5 mídias · 3 min"
   * (media-library-chip@mobile, -author@mobile); the menu keeps its name ("Ordenar: …").
   */
  readonly summary = input('');
  readonly sortChange = output<LibrarySort>();
  readonly viewChange = output<LibraryView>();

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
      ...LIBRARY_VIEWS.map((view) => ({
        id: `${VIEW_PREFIX}${view}`,
        label: VIEW_LABELS[view](),
        icon: view === 'grid' ? ('grid' as const) : ('list' as const),
        checked: view === this.view(),
        group: viewGroup,
      })),
    ];
  });
  protected readonly sortName = computed(() => SORT_LABELS[this.sort()]());
  protected readonly sortLabel = computed(
    () =>
      $localize`:@@library.sortBy:Ordenar: ${SORT_LABELS[this.sort()]()}:sort:`,
  );

  protected choose(id: string): void {
    const view = LIBRARY_VIEWS.find((one) => `${VIEW_PREFIX}${one}` === id);
    if (view) {
      if (view !== this.view()) this.viewChange.emit(view);
      return;
    }
    const sort = LIBRARY_SORTS.find((one) => one === id);
    if (sort) this.sortChange.emit(sort);
  }
}
