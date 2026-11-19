import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  Injector,
  afterNextRender,
  computed,
  inject,
  input,
  output,
  signal,
  viewChild,
  viewChildren,
} from '@angular/core';
import { UiCover } from '@ui/cover.js';
import { UiIcon } from '@ui/icon.js';
import type { IconName } from '@ui/icons.js';
import {
  UiOverlay,
  outsideBox,
  type OverlayAlign,
  type OverlayOffset,
  type OverlaySide,
} from '@ui/overlay.js';

/** One item of a menu: an action, or one of the choices with the current one checked. */
export interface MenuOption {
  readonly id: string;
  readonly label: string;
  readonly checked?: boolean;
  readonly danger?: boolean;
  /** A v2 menu icon before the words (decorative: the words carry the meaning). */
  readonly icon?: IconName;
  /** The group it belongs to ("Ordenar por", "Ver como"): named once, above its first item. */
  readonly group?: string;
  /** A line above it, to set it apart (a destructive action goes last, after one). */
  readonly divider?: boolean;
  /** On a phone's sheet its group's items are pills in one row ("Ver como", @mobile). */
  readonly pill?: boolean;
  /** An action among the choices of a `kind="choice"` menu: no ✓, no radio role. */
  readonly action?: boolean;
  /**
   * A short state after the words, at the right ("ligado"); the item's name is
   * "<label>: <trail>", so it says the state in words (UP-20).
   */
  readonly trail?: string;
  /** A key that does it, shown at the right ("?"); the item's name stays its words. */
  readonly keyHint?: string;
}

/** Items under the name of their group, in the order given. */
interface MenuGroup {
  readonly name: string;
  readonly pills: boolean;
  readonly items: readonly { option: MenuOption; index: number }[];
}

/** Below this width the menu is a sheet from the bottom (the shell's phone layout, D5). */
const SHEET_BELOW_PX = 1024;

/**
 * A button that opens a menu (APG menu button): Enter/Space/↓ opens on the first item (or
 * the checked one), ↑ on the last, ↑/↓ move, Escape closes and Tab leaves, and the focus
 * goes back to the button. `kind="choice"` makes the items radio items with the current
 * one checked by a ✓ and `aria-checked`, never by color alone (UP-20). The list lives in
 * the top layer, anchored to the button and kept inside the screen (redesign v2, D5);
 * below 1024 px it is a sheet from the bottom.
 */
@Component({
  selector: 'app-menu-button',
  imports: [UiCover, UiIcon, UiOverlay],
  template: `
    <button
      #trigger
      type="button"
      class="trigger"
      [class.chip]="look() === 'chip'"
      aria-haspopup="menu"
      [attr.aria-expanded]="open()"
      [attr.aria-label]="label()"
      [attr.aria-keyshortcuts]="keyshortcuts()"
      [disabled]="disabled()"
      (click)="toggle()"
      (keydown)="onTriggerKey($event)"
    >
      <ng-content />
    </button>
    @if (open()) {
      <div
        #menu
        class="menu"
        [class.choices]="kind() === 'choice'"
        [class.spaced]="spaced()"
        role="menu"
        tabindex="-1"
        [uiOverlay]="trigger"
        [overlayAlign]="align()"
        [overlaySide]="side()"
        [overlayOffset]="offset()"
        [overlaySheetBelow]="sheetBelow"
        [attr.aria-label]="menuLabel() || label()"
        (keydown)="onMenuKey($event)"
        (focusout)="onFocusOut($event)"
      >
        <!-- The sheet's handle and, for a media, what it is (media-library-row-menu@mobile). -->
        <span class="handle" aria-hidden="true"></span>
        @if (sheetTitle(); as title) {
          <div class="sheet-head" aria-hidden="true">
            <ui-cover [title]="title" [size]="48" />
            <span class="sheet-words">
              <span class="sheet-title">{{ title }}</span>
              @if (sheetMeta(); as meta) {
                <span class="sheet-meta">{{ meta }}</span>
              }
            </span>
          </div>
        }
        <!-- What the sheet is about, given by the page (player.js mOver: the cover and title). -->
        <div class="sheet-slot"><ng-content select="[sheetHead]" /></div>
        @if (titled()) {
          <!-- The menu's name over its items (speedMenu, mTitle): read as its label. -->
          <p class="title" aria-hidden="true">{{ menuLabel() || label() }}</p>
        }
        @for (group of groups(); track $index) {
          <div
            class="group"
            [class.pills]="group.pills"
            [attr.role]="group.name ? 'group' : null"
            [attr.aria-label]="group.name || null"
          >
            @if (group.name) {
              <p class="heading" aria-hidden="true">{{ group.name }}</p>
            }
            <div class="items">
              @for (entry of group.items; track entry.option.id) {
                @if (entry.option.divider) {
                  <hr class="divider" aria-hidden="true" />
                }
                <button
                  #item
                  type="button"
                  [attr.role]="
                    radio(entry.option) ? 'menuitemradio' : 'menuitem'
                  "
                  [attr.aria-checked]="
                    radio(entry.option) ? (entry.option.checked ?? false) : null
                  "
                  [attr.aria-label]="
                    entry.option.trail
                      ? entry.option.label + ': ' + entry.option.trail
                      : null
                  "
                  [class.danger]="entry.option.danger"
                  [class.checked]="entry.option.checked"
                  (focus)="focused.set(entry.index)"
                  (click)="choose(entry.option.id)"
                >
                  @if (entry.option.icon; as icon) {
                    <ui-icon [name]="icon" [size]="18" />
                  }
                  <span class="words">{{ entry.option.label }}</span>
                  @if (entry.option.trail; as trail) {
                    <span class="trail" aria-hidden="true">{{ trail }}</span>
                  } @else if (entry.option.keyHint; as key) {
                    <span class="trail" aria-hidden="true">{{ key }}</span>
                  }
                  @if (radio(entry.option)) {
                    <!-- v2 menus: the chosen one's ✓ drawn as the check icon. -->
                    <span class="check" aria-hidden="true">
                      @if (entry.option.checked) {
                        <ui-icon name="check" [size]="16" />
                      }
                    </span>
                  }
                </button>
              }
            </div>
          </div>
        }
      </div>
    }
  `,
  styleUrl: './menu-button.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MenuButton {
  private readonly injector = inject(Injector);
  private readonly host =
    inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;
  /**
   * The document's clicks, heard only while this menu is open. Not a `(document:click)` host
   * listener: with one ⋯ per row, every click anywhere ran 2 000 Angular listeners, and each
   * marked its row for a check, so all 2 000 rows were checked again (NFR-2).
   */
  private readonly onDocumentClick = (event: MouseEvent): void =>
    this.closeOnOutside(event);
  private hearingOutside = false;
  private readonly trigger =
    viewChild.required<ElementRef<HTMLButtonElement>>('trigger');
  private readonly items = viewChildren<ElementRef<HTMLButtonElement>>('item');
  private readonly menu = viewChild<ElementRef<HTMLElement>>('menu');

  /** The button's accessible name. */
  readonly label = input.required<string>();
  /** The menu's accessible name, when it differs from the button's. */
  readonly menuLabel = input('');
  readonly options = input.required<readonly MenuOption[]>();
  readonly kind = input<'action' | 'choice'>('action');
  readonly keyshortcuts = input<string | null>(null);
  readonly disabled = input(false);
  /** Which edge of the button the list lines up with. */
  readonly align = input<OverlayAlign>('end');
  /** A chip that opens a menu (v2 · Componentes › Chip with ▾), as in a row of filters. */
  readonly look = input<'plain' | 'chip'>('plain');
  /** On a phone's sheet, the item it is about: its cover and title over the items. */
  readonly sheetTitle = input('');
  /** Under that title ("Irmã Helena Prado · Alquimia Prática"). */
  readonly sheetMeta = input('');
  /** Below the button, or over its row from `offset` (the v2 player's menus). */
  readonly side = input<OverlaySide>('below');
  readonly offset = input<OverlayOffset | null>(null);
  /** The menu's name shown over its items (the speed menu of the v2 player). */
  readonly titled = input(false);
  /** The player's sheets (pMobile sheet(kids)): rows 4 apart, not touching. */
  readonly spaced = input(false);
  readonly chosen = output<string>();

  protected readonly sheetBelow = SHEET_BELOW_PX;
  protected readonly open = signal(false);
  /** The item that has the focus, as the items report it. */
  protected readonly focused = signal(0);
  protected readonly groups = computed<readonly MenuGroup[]>(() => {
    const groups: {
      name: string;
      pills: boolean;
      items: MenuGroup['items'][number][];
    }[] = [];
    this.options().forEach((option, index) => {
      const name = option.group ?? '';
      const pills = option.pill === true;
      const last = groups.at(-1);
      if (last && last.name === name && last.pills === pills)
        last.items.push({ option, index });
      else groups.push({ name, pills, items: [{ option, index }] });
    });
    return groups;
  });
  private readonly checkedIndex = computed(() =>
    Math.max(
      0,
      this.options().findIndex((option) => option.checked),
    ),
  );

  /** A choice of a `kind="choice"` menu (an action among them is a plain item). */
  protected radio(option: MenuOption): boolean {
    return this.kind() === 'choice' && !option.action;
  }

  /** Whether its menu is open (a row keeps its look under the pointer meanwhile). */
  readonly isOpen = computed(() => this.open());

  /** Opens it from elsewhere (a phone recording's long press, media-library@mobile). */
  openMenu(): void {
    if (!this.open()) this.openOn(this.checkedIndex());
  }

  protected toggle(): void {
    if (this.open()) this.close(true);
    else this.openOn(this.checkedIndex());
  }

  protected onTriggerKey(event: KeyboardEvent): void {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    event.preventDefault();
    this.openOn(event.key === 'ArrowUp' ? -1 : this.checkedIndex());
  }

  protected onMenuKey(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      this.close(true);
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      this.move(event.key === 'ArrowDown' ? 1 : -1);
    } else if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault();
      this.focusItem(event.key === 'Home' ? 0 : -1);
    } else if (event.key === 'Tab') this.close(false);
  }

  protected onFocusOut(event: FocusEvent): void {
    const next = event.relatedTarget;
    if (next instanceof Node && !this.host.contains(next)) this.shut();
  }

  /** A click outside, or on the phone sheet's scrim (the list's own backdrop). */
  private closeOnOutside(event: MouseEvent): void {
    if (!this.open() || !(event.target instanceof Node)) return;
    const menu = this.menu()?.nativeElement;
    const onScrim = event.target === menu && outsideBox(menu, event);
    if (onScrim || !this.host.contains(event.target)) this.shut();
  }

  protected choose(id: string): void {
    this.close(true);
    this.chosen.emit(id);
  }

  private openOn(index: number): void {
    this.open.set(true);
    this.hearOutside();
    afterNextRender(() => this.focusItem(index), { injector: this.injector });
  }

  private move(step: number): void {
    const count = this.items().length;
    this.focusItem((this.focused() + step + count) % count);
  }

  private focusItem(index: number): void {
    const items = this.items();
    items.at(index < 0 ? items.length - 1 : index)?.nativeElement.focus();
  }

  private hearOutside(): void {
    if (this.hearingOutside) return;
    this.hearingOutside = true;
    this.host.ownerDocument.addEventListener('click', this.onDocumentClick);
  }

  private stopHearingOutside(): void {
    if (!this.hearingOutside) return;
    this.hearingOutside = false;
    this.host.ownerDocument.removeEventListener('click', this.onDocumentClick);
  }

  constructor() {
    inject(DestroyRef).onDestroy(() => this.stopHearingOutside());
  }

  /** Puts the focus on the trigger (a neighbour that went away hands it here). */
  focus(): void {
    this.trigger().nativeElement.focus();
  }

  private close(refocus: boolean): void {
    this.shut();
    if (refocus) this.trigger().nativeElement.focus();
  }

  /** Closed, it hears the document no more, however it closed. */
  private shut(): void {
    this.open.set(false);
    this.stopHearingOutside();
  }
}
