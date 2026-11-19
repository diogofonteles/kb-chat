import {
  ChangeDetectionStrategy,
  Component,
  DOCUMENT,
  DestroyRef,
  ElementRef,
  computed,
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
 * "Cancelar · título · ação" when `primaryLabel` is set (the footer then hides), or a
 * low sheet with a handle for a `confirm`ation.
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
      [class.ui-dialog--actions]="sheetHead()"
      [class.ui-dialog--confirm]="confirm()"
      [class.ui-dialog--wide]="width() >= 800"
      [style.--ui-dialog-width.px]="width()"
      [style.--ui-dialog-height.px]="height() || null"
      [style.--ui-dialog-top.px]="top() || null"
      [style.--ui-dialog-lift.px]="lift() || null"
      [attr.aria-labelledby]="label() ? null : titleId()"
      [attr.aria-label]="label() || null"
      (close)="closed.emit()"
      (pointerdown)="pressedOnBackdrop = $event.target === $event.currentTarget"
      (click)="backdropClick($event)"
    >
      <span class="ui-dialog__handle" aria-hidden="true"></span>
      <header class="ui-dialog__head">
        <!-- The sheet's own Cancelar and action exist on phones only: on a desktop the
             footer holds them, and two of each would read twice. -->
        @if (sheetHead() && phone()) {
          <button type="button" class="ui-dialog__cancel" (click)="close()">
            @if (cancelLabel()) {
              {{ cancelLabel() }}
            } @else {
              <ng-container i18n="@@ui.dialog.cancel">Cancelar</ng-container>
            }
          </button>
        }
        <!-- [uiDialogLead]: a picture before the titles (a person's avatar). -->
        <ng-content select="[uiDialogLead]" />
        <div class="ui-dialog__titles">
          @if (step()) {
            <p class="ui-dialog__step">{{ step() }}</p>
          }
          <h2 class="ui-dialog__title" [attr.id]="titleId()">
            {{ phone() && phoneTitle() ? phoneTitle() : title() }}
          </h2>
          <!-- [uiDialogSub]: a line under the title (an e-mail and a status). -->
          <ng-content select="[uiDialogSub]" />
        </div>
        @if (primaryLabel() && phone()) {
          <button
            type="button"
            class="ui-dialog__primary"
            [disabled]="primaryDisabled()"
            [attr.aria-describedby]="primaryDescribedBy() || null"
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
  /** At a desktop, the modal's distance from the screen's top (the frame's); 0 centres it. */
  readonly top = input(0);
  /** At a desktop, how far above the screen's middle the modal sits (the frames' 52); 0 centres it. */
  readonly lift = input(0);
  /**
   * The dialog's name when the visible title would repeat a field's name inside it (the
   * invitation's "Convidar por e-mail"); empty names it by the title.
   */
  readonly label = input('');
  /** The phone header's action ("Criar", "Salvar"); empty keeps the footer on phones. */
  readonly primaryLabel = input('');
  readonly primaryDisabled = input(false);
  /** The id of what says why the phone header's action waits (a hint in the content). */
  readonly primaryDescribedBy = input('');
  /**
   * The phone sheet's left word when it is not "Cancelar" ("Fechar" on an editor that saves
   * as it goes); set alone, it gives the sheet its header without an action at the right.
   */
  readonly cancelLabel = input('');
  /** The phone header's shorter title ("Convite"); empty keeps `title`. */
  readonly phoneTitle = input('');
  /**
   * A confirmation ("Revogar …?"): below 1024 px a low sheet with a handle, no ✕, and the
   * footer's actions full width, the action above Cancelar (smConfirm).
   */
  readonly confirm = input(false);
  /**
   * A click on the backdrop closes the dialog; false where closing loses work the person
   * set up (a configured invitation): only ✕, Cancelar and Escape close it then.
   */
  readonly closeOnBackdrop = input(true);
  readonly primary = output();
  readonly closed = output();
  private readonly dialog =
    viewChild.required<ElementRef<HTMLDialogElement>>('dialog');

  /** The phone sheet's "Cancelar · título · ação" header (or "Fechar · título"). */
  protected readonly sheetHead = computed(
    () => !!this.primaryLabel() || !!this.cancelLabel(),
  );

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
