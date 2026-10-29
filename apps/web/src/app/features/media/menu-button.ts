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

/** One item of a menu: an action, or one of the choices with the current one checked. */
export interface MenuOption {
  readonly id: string;
  readonly label: string;
  readonly checked?: boolean;
  readonly danger?: boolean;
}

/**
 * A button that opens a menu (APG menu button): Enter/Space/↓ opens on the first item (or
 * the checked one), ↑ on the last, ↑/↓ move, Escape closes and Tab leaves, and the focus
 * goes back to the button. `kind="choice"` makes the items radio items with the current
 * one checked by a ✓ and `aria-checked`, never by color alone (UP-20).
 */
@Component({
  selector: 'app-menu-button',
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
        class="menu"
        role="menu"
        tabindex="-1"
        [attr.aria-label]="menuLabel() || label()"
        (keydown)="onMenuKey($event)"
        (focusout)="onFocusOut($event)"
      >
        @for (option of options(); track option.id; let index = $index) {
          <button
            #item
            type="button"
            [attr.role]="kind() === 'choice' ? 'menuitemradio' : 'menuitem'"
            [attr.aria-checked]="
              kind() === 'choice' ? (option.checked ?? false) : null
            "
            [class.danger]="option.danger"
            (focus)="focused.set(index)"
            (click)="choose(option.id)"
          >
            @if (kind() === 'choice') {
              <span class="check" aria-hidden="true">{{
                option.checked ? '✓' : ''
              }}</span>
            }
            {{ option.label }}
          </button>
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

  /** The button's accessible name. */
  readonly label = input.required<string>();
  /** The menu's accessible name, when it differs from the button's. */
  readonly menuLabel = input('');
  readonly options = input.required<readonly MenuOption[]>();
  readonly kind = input<'action' | 'choice'>('action');
  readonly keyshortcuts = input<string | null>(null);
  readonly disabled = input(false);
  readonly chosen = output<string>();

  protected readonly open = signal(false);
  /** The item that has the focus, as the items report it. */
  protected readonly focused = signal(0);
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

  protected closeOnOutside(event: MouseEvent): void {
    if (
      this.open() &&
      event.target instanceof Node &&
      !this.host.contains(event.target)
    )
      this.open.set(false);
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
