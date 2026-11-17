import {
  ChangeDetectionStrategy,
  Component,
  computed,
  ElementRef,
  inject,
  input,
  output,
  signal,
  viewChild,
} from '@angular/core';
import type { Person } from '@kb-chat/contracts';
import { errorMessage, toUiErrorCode } from '@core/api/api-error.js';
import { ActAsApi, RESTART_APP } from '@core/auth/act-as-api.js';

import { UiButton, UiDialog, UiIcon } from '@ui/index.js';

const REASON_MIN = 3;
const REASON_MAX = 500;

/**
 * "Ver como" (KBC-060 FR-6): why the master acts as this person, required and kept in the
 * audit; starting reloads the app as the person (ADR 0027). Esc and "Cancelar" close it and
 * give the focus back.
 */
@Component({
  selector: 'app-act-as-dialog',
  imports: [UiButton, UiDialog, UiIcon],
  template: `
    <!-- A v2 modal on a desktop; on a phone the tall sheet "Cancelar · título · Ver como"
         (v2 · Configurações › Ver como, celular). -->
    <ui-dialog
      #dialog
      titleId="act-as-title"
      [title]="title()"
      [width]="520"
      i18n-primaryLabel="@@actAs.startShort"
      primaryLabel="Ver como"
      [primaryDisabled]="busy()"
      (primary)="start(reason.value)"
      (closed)="closed.emit()"
    >
      <p class="hint" i18n="@@actAs.explain">
        Você vai usar o app com os acervos, as permissões e os dados desta
        pessoa por até 30 minutos. Tudo o que você alterar fica registrado, e a
        pessoa vê este acesso em Configurações.
      </p>
      <label class="field" for="act-as-reason">
        <span i18n="@@actAs.reason">Motivo</span>
        <textarea
          #reason
          id="act-as-reason"
          class="ui-input"
          rows="1"
          [attr.maxlength]="reasonMax"
          [attr.aria-invalid]="invalid() ? 'true' : null"
          [attr.aria-describedby]="invalid() ? 'act-as-reason-error' : null"
          (input)="invalid.set(false)"
        ></textarea>
      </label>
      @if (invalid()) {
        <p id="act-as-reason-error" class="error">
          <ui-icon name="xcircle" [size]="14" />
          <span i18n="@@actAs.reasonRequired"
            >Escreva o motivo (pelo menos 3 letras).</span
          >
        </p>
      }
      @if (failure(); as message) {
        <p class="error" role="alert">{{ message }}</p>
      }
      <div uiDialogFooter class="actions">
        <button
          uiButton="ghost"
          type="button"
          (click)="close()"
          i18n="@@actAs.cancel"
        >
          Cancelar
        </button>
        <button
          uiButton="white"
          type="button"
          [disabled]="busy()"
          (click)="start(reason.value)"
        >
          <ui-icon name="eye" [size]="18" />
          <span i18n="@@actAs.start">Ver como esta pessoa</span>
        </button>
      </div>
    </ui-dialog>
  `,
  styleUrl: './act-as-dialog.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ActAsDialog {
  private readonly api = inject(ActAsApi);
  private readonly restart = inject(RESTART_APP);
  private readonly dialog = viewChild.required<UiDialog>('dialog');
  private readonly reason =
    viewChild.required<ElementRef<HTMLTextAreaElement>>('reason');

  readonly person = input.required<Person>();
  readonly closed = output();

  protected readonly title = computed(() => {
    const name = this.person().name || this.person().email;
    return $localize`:@@actAs.title:Ver como ${name}:name:`;
  });

  protected readonly reasonMax = REASON_MAX;
  protected readonly invalid = signal(false);
  protected readonly busy = signal(false);
  protected readonly failure = signal<string | null>(null);

  open(): void {
    this.invalid.set(false);
    this.failure.set(null);
    this.reason().nativeElement.value = '';
    this.dialog().open();
  }

  protected close(): void {
    this.dialog().close();
  }

  protected start(text: string): void {
    const reason = text.trim();
    if (reason.length < REASON_MIN) {
      this.invalid.set(true);
      this.reason().nativeElement.focus();
      return;
    }
    this.busy.set(true);
    this.api.start(this.person().id, reason).subscribe({
      next: () => this.restart(),
      error: (err: unknown) => {
        this.busy.set(false);
        this.failure.set(errorMessage(toUiErrorCode(err)));
      },
    });
  }
}
