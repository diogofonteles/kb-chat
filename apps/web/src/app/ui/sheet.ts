import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  input,
  output,
  viewChild,
} from '@angular/core';
import { UiIcon } from './icon.js';

/**
 * A v2 phone sheet (v2 · Componentes › Folha do celular), on a native modal `<dialog>`: it
 * rises from the bottom with a handle and 16 corners; `full` fills the screen ("Sua
 * biblioteca", a tall form). The ✕ and Escape close it; so does a tap on the backdrop.
 */
@Component({
  selector: 'ui-sheet',
  imports: [UiIcon],
  template: `
    <!-- The backdrop tap is a pointer way out only: Escape and ✕ close it too. -->
    <!-- eslint-disable-next-line @angular-eslint/template/click-events-have-key-events, @angular-eslint/template/interactive-supports-focus -->
    <dialog
      #dialog
      class="ui-sheet"
      [class.ui-sheet--full]="full()"
      [attr.aria-label]="label()"
      (close)="closed.emit()"
      (click)="backdropClick($event)"
    >
      <div class="ui-sheet__box">
        <span class="ui-sheet__handle" aria-hidden="true"></span>
        @if (closable()) {
          <button
            type="button"
            class="ui-sheet__close"
            aria-label="Fechar"
            i18n-aria-label="@@ui.dialog.close"
            (click)="close()"
          >
            <ui-icon name="close" [size]="22" />
          </button>
        }
        <ng-content />
      </div>
    </dialog>
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class UiSheet {
  /** The sheet's accessible name ("Menu", "Filtros"). */
  readonly label = input.required<string>();
  readonly full = input(false);
  readonly closable = input(true);
  readonly closed = output();
  private readonly dialog =
    viewChild.required<ElementRef<HTMLDialogElement>>('dialog');

  get isOpen(): boolean {
    return this.dialog().nativeElement.open;
  }

  open(): void {
    const dialog = this.dialog().nativeElement;
    if (!dialog.open) dialog.showModal();
  }

  close(): void {
    this.dialog().nativeElement.close();
  }

  protected backdropClick(event: MouseEvent): void {
    if (event.target === event.currentTarget) this.close();
  }
}
