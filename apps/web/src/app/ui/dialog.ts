import {
  ChangeDetectionStrategy,
  Component,
  DOCUMENT,
  DestroyRef,
  ElementRef,
  inject,
  input,
  output,
  signal,
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
      [style.--ui-dialog-width.px]="width()"
      [style.--ui-dialog-height.px]="height() || null"
      [attr.aria-labelledby]="label() ? null : titleId()"
      [attr.aria-label]="label() || null"
      (close)="closed.emit()"
      (pointerdown)="pressedOnBackdrop = $event.target === $event.currentTarget"
      (click)="backdropClick($event)"
    >
      <header class="ui-dialog__head">
        <!-- The sheet's own Cancelar and action exist on phones only: on a desktop the
             footer holds them, and two of each would read twice. -->
        @if (primaryLabel() && phone()) {
          <button
            type="button"
            class="ui-dialog__cancel"
            (click)="close()"
            i18n="@@ui.dialog.cancel"
          >
            Cancelar
          </button>
        }
        <!-- [uiDialogLead]: a picture before the titles (a person's avatar). -->
        <ng-content select="[uiDialogLead]" />
        <div class="ui-dialog__titles">
          @if (step()) {
            <p class="ui-dialog__step">{{ step() }}</p>
          }
          <h2 class="ui-dialog__title" [attr.id]="titleId()">{{ title() }}</h2>
          <!-- [uiDialogSub]: a line under the title (an e-mail and a status). -->
          <ng-content select="[uiDialogSub]" />
        </div>
        @if (primaryLabel() && phone()) {
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
  /** A fixed height (the wide modals with tabs keep theirs from tab to tab); 0 fits. */
  readonly height = input(0);
  /**
   * The dialog's name when the visible title would repeat a field's name inside it (the
   * invitation's "Convidar por e-mail"); empty names it by the title.
   */
  readonly label = input('');
  /** The phone header's action ("Criar", "Salvar"); empty keeps the footer on phones. */
  readonly primaryLabel = input('');
  readonly primaryDisabled = input(false);
  /**
   * A click on the backdrop closes the dialog; false where closing loses work the person
   * set up (a configured invitation): only ✕, Cancelar and Escape close it then.
   */
  readonly closeOnBackdrop = input(true);
  readonly primary = output();
  readonly closed = output();
  private readonly dialog =
    viewChild.required<ElementRef<HTMLDialogElement>>('dialog');

  /** Below 1024 px: the tall sheet with "Cancelar · título · ação". */
  protected readonly phone = signal(false);

  constructor() {
    const query = inject(DOCUMENT).defaultView?.matchMedia?.(
      '(max-width: 1023px)',
    );
    if (!query) return;
    this.phone.set(query.matches);
    const onChange = (event: MediaQueryListEvent) =>
      this.phone.set(event.matches);
    query.addEventListener('change', onChange);
    inject(DestroyRef).onDestroy(() =>
      query.removeEventListener('change', onChange),
    );
  }

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
