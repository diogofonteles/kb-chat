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
 * A v2 modal (v2 · Componentes › Modal), on a native `<dialog>` (focus trap, Escape, the
 * top layer): dark, centred, 22 title with an optional step above it, ✕ in the corner and
 * the actions (`[uiDialogFooter]`) on the right. Below 1024 px it is a tall sheet with
 * "Cancelar · título · ação" when `primaryLabel` is set (the footer then hides).
 * Open and close with `open()` / `close()`; `closed` fires however it closed.
 */
@Component({
  selector: 'ui-dialog',
  imports: [UiIcon],
  template: `
    <!-- The backdrop click is a pointer way out only: Escape already closes the dialog. -->
    <!-- eslint-disable-next-line @angular-eslint/template/click-events-have-key-events, @angular-eslint/template/interactive-supports-focus -->
    <dialog
      #dialog
      class="ui-dialog"
      [class.ui-dialog--actions]="!!primaryLabel()"
      [class.ui-dialog--short]="short()"
      [style.--ui-dialog-width.px]="width()"
      [attr.aria-labelledby]="titleId()"
      (close)="closed.emit()"
      (pointerdown)="pressedOnBackdrop = $event.target === $event.currentTarget"
      (click)="backdropClick($event)"
    >
      <header class="ui-dialog__head">
        @if (primaryLabel()) {
          <button
            type="button"
            class="ui-dialog__cancel"
            (click)="close()"
            i18n="@@ui.dialog.cancel"
          >
            Cancelar
          </button>
        }
        <div class="ui-dialog__titles">
          @if (step()) {
            <p class="ui-dialog__step">{{ step() }}</p>
          }
          <h2 class="ui-dialog__title" [attr.id]="titleId()">{{ title() }}</h2>
        </div>
        @if (primaryLabel()) {
          <button
            type="button"
            class="ui-dialog__primary"
            [disabled]="primaryDisabled()"
            (click)="primary.emit()"
          >
            {{ primaryLabel() }}
          </button>
        }
        <button
          type="button"
          class="ui-dialog__close"
          aria-label="Fechar"
          i18n-aria-label="@@ui.dialog.close"
          (click)="close()"
        >
          <ui-icon name="close" [size]="20" />
        </button>
      </header>
      <div class="ui-dialog__body"><ng-content /></div>
      <footer class="ui-dialog__footer">
        <ng-content select="[uiDialogFooter]" />
      </footer>
    </dialog>
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class UiDialog {
  readonly title = input.required<string>();
  /** "PASSO 1 DE 4 · …" above the title. */
  readonly step = input('');
  /** The title's id (aria-labelledby); unique on the page. */
  readonly titleId = input.required<string>();
  readonly width = input(560);
  /** The phone header's action ("Criar", "Salvar"); empty keeps the footer on phones. */
  readonly primaryLabel = input('');
  readonly primaryDisabled = input(false);
  /**
   * A click on the backdrop closes the dialog; false where closing loses work the person
   * set up (a configured invitation): only ✕, Cancelar and Escape close it then.
   */
  readonly closeOnBackdrop = input(true);
  /**
   * A short question (a confirmation): below 1024 px a sheet as tall as its content, with
   * the handle on top and the actions across it, no ✕ (v2 · Mídia — Player, celular).
   */
  readonly short = input(false);
  readonly primary = output();
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

  /** The last press started on the backdrop, not inside the box. */
  protected pressedOnBackdrop = false;

  /**
   * A click on the backdrop lands on the <dialog> itself, outside its box. Both the press
   * and the release must be there: selecting text in a field and letting go outside the
   * box also ends in a click on the <dialog>.
   */
  protected backdropClick(event: MouseEvent): void {
    const pressed = this.pressedOnBackdrop;
    this.pressedOnBackdrop = false;
    if (
      this.closeOnBackdrop() &&
      pressed &&
      event.target === event.currentTarget
    )
      this.close();
  }
}
