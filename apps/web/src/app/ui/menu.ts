import { DOCUMENT } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  Directive,
  ElementRef,
  DestroyRef,
  afterNextRender,
  inject,
  Injector,
  input,
  signal,
  viewChild,
} from '@angular/core';
import { anchorOverlay, outsideBox } from './overlay.js';

/** Below this width a menu is a sheet from the bottom (the shell's phone layout). */
const SHEET_BELOW_PX = 1024;

/** The roles of a menu's items: a plain action, or one choice of a set (an order). */
const ITEM = '[role="menuitem"], [role="menuitemradio"]';
const ENABLED_ITEM =
  '[role="menuitem"]:not([disabled]), [role="menuitemradio"]:not([disabled])';

/**
 * An item of a UiMenu: a native button or link with the menu item role. Given `checked`, it
 * is one choice of a set (`menuitemradio`, aria-checked) and the chosen one shows a check.
 */
@Directive({
  selector: '[uiMenuItem]',
  host: {
    class: 'ui-menu__item',
    '[attr.role]': 'checked() === null ? "menuitem" : "menuitemradio"',
    '[attr.aria-checked]': 'checked()',
    tabindex: '-1',
    '[class.ui-menu__item--danger]': 'danger()',
  },
})
export class UiMenuItem {
  /** A destructive item, in the danger colour (with its own words). */
  readonly danger = input(false);
  /** One choice of a set: whether it is the chosen one (null: a plain action). */
  readonly checked = input<boolean | null>(null);
}

/**
 * A v2 menu (v2 · Componentes › Menu): the trigger (its content projected with
 * `[uiMenuTrigger]`) opens a #282828 list of 40 items under it; below 1024 px the same list
 * is a sheet from the bottom over a scrim. The list lives in the top layer, anchored to the
 * trigger and kept inside the viewport (D5): no container clips it. Arrows move, Escape
 * closes back to the trigger, a choice or a click outside closes it.
 */
@Component({
  selector: 'ui-menu',
  template: `
    <button
      #trigger
      type="button"
      [class]="'ui-menu__trigger ' + triggerClass()"
      aria-haspopup="menu"
      [attr.aria-expanded]="open()"
      [attr.aria-label]="triggerLabel() || null"
      [attr.aria-describedby]="triggerDescribedBy() || null"
      [attr.aria-controls]="menuId()"
      (click)="toggle()"
    >
      <ng-content select="[uiMenuTrigger]" />
    </button>
    <!-- Choosing an item closes the menu: the click bubbles up from the item. -->
    <!-- eslint-disable-next-line @angular-eslint/template/interactive-supports-focus -->
    <div
      #panel
      class="ui-menu__panel"
      role="menu"
      [attr.id]="menuId()"
      [attr.aria-label]="label()"
      [hidden]="!open()"
      (keydown)="keydown($event)"
      (click)="chosen($event)"
    >
      <ng-content />
    </div>
  `,
  host: {
    class: 'ui-menu',
    '(document:click)': 'outside($event)',
  },
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class UiMenu {
  /** The menu's name ("Conta", "Criar"). */
  readonly label = input.required<string>();
  /** The trigger's name when its content has no text (an avatar, an icon). */
  readonly triggerLabel = input('');
  /** The id of what the trigger is about, when its name is generic ("Mais opções"). */
  readonly triggerDescribedBy = input('');
  readonly triggerClass = input('');
  readonly menuId = input.required<string>();
  readonly align = input<'start' | 'end'>('start');
  readonly direction = input<'down' | 'up'>('down');
  protected readonly open = signal(false);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly injector = inject(Injector);
  private readonly document = inject(DOCUMENT);
  private readonly trigger =
    viewChild.required<ElementRef<HTMLButtonElement>>('trigger');
  private readonly panel = viewChild.required<ElementRef<HTMLElement>>('panel');
  /** Takes the open list out of the top layer. */
  private release: (() => void) | null = null;

  constructor() {
    inject(DestroyRef).onDestroy(() => this.release?.());
  }

  protected toggle(): void {
    if (this.open()) this.close();
    else this.show();
  }

  show(): void {
    this.open.set(true);
    afterNextRender(
      () => {
        this.release?.();
        this.release = anchorOverlay(
          this.panel().nativeElement,
          this.trigger().nativeElement,
          {
            align: this.align(),
            side: this.direction() === 'up' ? 'above' : 'below',
            sheetBelow: SHEET_BELOW_PX,
          },
        );
        this.items()[0]?.focus();
      },
      { injector: this.injector },
    );
  }

  close(focusTrigger = true): void {
    if (!this.open()) return;
    this.open.set(false);
    this.release?.();
    this.release = null;
    if (focusTrigger) this.trigger().nativeElement.focus();
  }

  protected keydown(event: KeyboardEvent): void {
    if (event.key === 'Tab') {
      this.close(false);
      return;
    }
    const action = this.keys[event.key];
    if (!action) return;
    event.preventDefault();
    action();
  }

  /** Escape, the arrows, Home and End (the menu pattern of the ARIA APG). */
  private readonly keys: Record<string, (() => void) | undefined> = {
    Escape: () => this.close(),
    ArrowDown: () => this.move(1),
    ArrowUp: () => this.move(-1),
    Home: () => this.items()[0]?.focus(),
    End: () => this.items().at(-1)?.focus(),
  };

  /**
   * A choice closes the menu. The item's own handler ran first (the click bubbles up from
   * it): when it took the focus elsewhere (a dialog, a field) the focus stays there, else it
   * goes back to the trigger instead of dropping to the page (APG menu button).
   */
  protected chosen(event: MouseEvent): void {
    const item = (event.target as HTMLElement).closest(ITEM);
    if (!item) return;
    this.close(false);
    afterNextRender(
      () => {
        const at = this.document.activeElement;
        const lost =
          !at ||
          at === this.document.body ||
          this.panel().nativeElement.contains(at);
        if (lost) this.trigger().nativeElement.focus();
      },
      { injector: this.injector },
    );
  }

  /** A click outside, or on the phone sheet's scrim (the panel's own backdrop). */
  protected outside(event: MouseEvent): void {
    const panel = this.panel().nativeElement;
    const onScrim = event.target === panel && outsideBox(panel, event);
    if (onScrim || !this.host.nativeElement.contains(event.target as Node))
      this.close(false);
  }

  private move(step: number): void {
    const items = this.items();
    const at = items.indexOf(this.document.activeElement as HTMLElement);
    items[(at + step + items.length) % items.length]?.focus();
  }

  private items(): HTMLElement[] {
    return [
      ...this.panel().nativeElement.querySelectorAll<HTMLElement>(ENABLED_ITEM),
    ];
  }
}
