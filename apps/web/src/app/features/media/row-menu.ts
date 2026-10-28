import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  Injector,
  afterNextRender,
  inject,
  input,
  output,
  signal,
  viewChild,
  viewChildren,
} from '@angular/core';

/**
 * The "⋯" menu of a media row (T14): actions that should not shout from every row, such
 * as "Remover". Menu button pattern (APG): Enter/Space/↓ opens on the first item, ↑/↓ move,
 * Escape and Tab close, and the focus goes back to the button.
 */
@Component({
  selector: 'app-row-menu',
  template: `
    <button
      #trigger
      type="button"
      class="trigger"
      aria-haspopup="menu"
      [attr.aria-expanded]="open()"
      [attr.aria-label]="label()"
      (click)="toggle()"
      (keydown)="onTriggerKey($event)"
    >
      <span aria-hidden="true">⋯</span>
    </button>
    @if (open()) {
      <div
        class="menu"
        role="menu"
        tabindex="-1"
        [attr.aria-label]="label()"
        (keydown)="onMenuKey($event)"
        (focusout)="onFocusOut($event)"
      >
        <button
          #item
          type="button"
          role="menuitem"
          class="danger"
          (click)="choose()"
          i18n="@@media.remove"
        >
          Remover
        </button>
      </div>
    }
  `,
  styleUrl: './row-menu.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { '(document:click)': 'closeOnOutside($event)' },
})
export class RowMenu {
  private readonly injector = inject(Injector);
  private readonly host =
    inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;
  private readonly trigger =
    viewChild.required<ElementRef<HTMLButtonElement>>('trigger');
  private readonly items = viewChildren<ElementRef<HTMLButtonElement>>('item');

  readonly label = input.required<string>();
  readonly removeChosen = output();

  protected readonly open = signal(false);

  protected toggle(): void {
    if (this.open()) this.close(true);
    else this.openOn(0);
  }

  protected onTriggerKey(event: KeyboardEvent): void {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    event.preventDefault();
    this.openOn(event.key === 'ArrowUp' ? -1 : 0);
  }

  protected onMenuKey(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      event.preventDefault();
      this.close(true);
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      this.move(event.key === 'ArrowDown' ? 1 : -1);
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

  protected choose(): void {
    this.close(true);
    this.removeChosen.emit();
  }

  private openOn(index: number): void {
    this.open.set(true);
    afterNextRender(() => this.focusItem(index), { injector: this.injector });
  }

  private move(step: number): void {
    const items = this.items().map((ref) => ref.nativeElement);
    const current = items.indexOf(document.activeElement as HTMLButtonElement);
    this.focusItem((current + step + items.length) % items.length);
  }

  private focusItem(index: number): void {
    const items = this.items();
    items.at(index < 0 ? items.length - 1 : index)?.nativeElement.focus();
  }

  private close(refocus: boolean): void {
    this.open.set(false);
    if (refocus) this.trigger().nativeElement.focus();
  }
}
