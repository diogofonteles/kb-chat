import { DOCUMENT } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  Directive,
  ElementRef,
  afterNextRender,
  inject,
  Injector,
  input,
  signal,
  viewChild,
} from '@angular/core';

/** An item of a UiMenu: a native button or link with the menu item role. */
@Directive({
  selector: '[uiMenuItem]',
  host: {
    class: 'ui-menu__item',
    role: 'menuitem',
    tabindex: '-1',
    '[class.ui-menu__item--danger]': 'danger()',
  },
})
export class UiMenuItem {
  /** A destructive item, in the danger colour (with its own words). */
  readonly danger = input(false);
}

/**
 * A v2 menu (v2 · Componentes › Menu): the trigger (its content projected with
 * `[uiMenuTrigger]`) opens a #282828 list of 40 items under it; below 1024 px the same list
 * is a sheet from the bottom over a scrim. Arrows move, Escape closes back to the trigger,
 * a choice or a click outside closes it.
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
      [attr.aria-controls]="menuId()"
      (click)="toggle()"
    >
      <ng-content select="[uiMenuTrigger]" />
    </button>
    @if (open()) {
      <!-- The scrim closes the phone sheet on a tap; Escape closes it from the keyboard. -->
      <!-- eslint-disable-next-line @angular-eslint/template/click-events-have-key-events, @angular-eslint/template/interactive-supports-focus -->
      <div class="ui-menu__scrim" (click)="close()"></div>
    }
    <!-- Choosing an item closes the menu: the click bubbles up from the item. -->
    <!-- eslint-disable-next-line @angular-eslint/template/interactive-supports-focus -->
    <div
      #panel
      class="ui-menu__panel"
      role="menu"
      [attr.id]="menuId()"
      [attr.aria-label]="label()"
      [class.ui-menu__panel--end]="align() === 'end'"
      [class.ui-menu__panel--up]="direction() === 'up'"
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

  protected toggle(): void {
    if (this.open()) this.close();
    else this.show();
  }

  show(): void {
    this.open.set(true);
    afterNextRender(() => this.items()[0]?.focus(), {
      injector: this.injector,
    });
  }

  close(focusTrigger = true): void {
    if (!this.open()) return;
    this.open.set(false);
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

  protected chosen(event: MouseEvent): void {
    const item = (event.target as HTMLElement).closest('[role="menuitem"]');
    if (item) this.close(false);
  }

  protected outside(event: MouseEvent): void {
    if (!this.host.nativeElement.contains(event.target as Node))
      this.close(false);
  }

  private move(step: number): void {
    const items = this.items();
    const at = items.indexOf(this.document.activeElement as HTMLElement);
    items[(at + step + items.length) % items.length]?.focus();
  }

  private items(): HTMLElement[] {
    return [
      ...this.panel().nativeElement.querySelectorAll<HTMLElement>(
        '[role="menuitem"]:not([disabled])',
      ),
    ];
  }
}
