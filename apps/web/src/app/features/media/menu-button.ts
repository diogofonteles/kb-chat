import {
  ChangeDetectionStrategy,
  Component,
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
import { UiIcon } from '@ui/icon.js';
import type { IconName } from '@ui/icons.js';
import { UiOverlay, outsideBox, type OverlayAlign } from '@ui/overlay.js';

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
  /**
   * A short state after the words, at the right ("ligado", "?"); read as "<label>: <trail>"
   * (a hidden colon), so the item's name says the state in words (UP-20).
   */
  readonly trail?: string;
  /** A key that does it, shown at the right ("?"); the item's name stays its words. */
  readonly keyHint?: string;
}

/** Items under the name of their group, in the order given. */
interface MenuGroup {
  readonly name: string;
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
  imports: [UiIcon, UiOverlay],
  template: `
    <button
      #trigger
      type="button"
      class="trigger"
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
        role="menu"
        tabindex="-1"
        [uiOverlay]="trigger"
        [overlayAlign]="align()"
        [overlaySheetBelow]="sheetBelow"
        [attr.aria-label]="menuLabel() || label()"
        (keydown)="onMenuKey($event)"
        (focusout)="onFocusOut($event)"
      >
        <!-- What the sheet is about, on a phone (player.js mOver: the cover and title). -->
        <div class="sheet-head"><ng-content select="[sheetHead]" /></div>
        @for (group of groups(); track $index) {
          <div
            class="group"
            [attr.role]="group.name ? 'group' : null"
            [attr.aria-label]="group.name || null"
          >
            @if (group.name) {
              <p class="heading" aria-hidden="true">{{ group.name }}</p>
            }
            @for (entry of group.items; track entry.option.id) {
              @if (entry.option.divider) {
                <hr class="divider" aria-hidden="true" />
              }
              <button
                #item
                type="button"
                [attr.role]="kind() === 'choice' ? 'menuitemradio' : 'menuitem'"
                [attr.aria-checked]="
                  kind() === 'choice' ? (entry.option.checked ?? false) : null
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
                  <span class="visually-hidden">:</span>&ngsp;<span
                    class="trail"
                    >{{ trail }}</span
                  >
                } @else if (entry.option.keyHint; as key) {
                  <span class="trail" aria-hidden="true">{{ key }}</span>
                }
                @if (kind() === 'choice') {
                  <span class="check" aria-hidden="true">{{
                    entry.option.checked ? '✓' : ''
                  }}</span>
                }
              </button>
            }
          </div>
        }
      </div>
    }
  `,
  styleUrl: './menu-button.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { '(document:click)': 'closeOnOutside($event)' },
})
export class MenuButton {
  private readonly injector = inject(Injector);
  private readonly host =
    inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;
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
  readonly chosen = output<string>();

  protected readonly sheetBelow = SHEET_BELOW_PX;
  protected readonly open = signal(false);
  /** The item that has the focus, as the items report it. */
  protected readonly focused = signal(0);
  protected readonly groups = computed<readonly MenuGroup[]>(() => {
    const groups: { name: string; items: MenuGroup['items'][number][] }[] = [];
    this.options().forEach((option, index) => {
      const name = option.group ?? '';
      const last = groups.at(-1);
      if (last && last.name === name) last.items.push({ option, index });
      else groups.push({ name, items: [{ option, index }] });
    });
    return groups;
  });
  private readonly checkedIndex = computed(() =>
    Math.max(
      0,
      this.options().findIndex((option) => option.checked),
    ),
  );

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
    if (next instanceof Node && !this.host.contains(next)) this.open.set(false);
  }

  /** A click outside, or on the phone sheet's scrim (the list's own backdrop). */
  protected closeOnOutside(event: MouseEvent): void {
    if (!this.open() || !(event.target instanceof Node)) return;
    const menu = this.menu()?.nativeElement;
    const onScrim = event.target === menu && outsideBox(menu, event);
    if (onScrim || !this.host.contains(event.target)) this.open.set(false);
  }

  protected choose(id: string): void {
    this.close(true);
    this.chosen.emit(id);
  }

  private openOn(index: number): void {
    this.open.set(true);
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

  /** Puts the focus on the trigger (a neighbour that went away hands it here). */
  focus(): void {
    this.trigger().nativeElement.focus();
  }

  private close(refocus: boolean): void {
    this.open.set(false);
    if (refocus) this.trigger().nativeElement.focus();
  }
}
