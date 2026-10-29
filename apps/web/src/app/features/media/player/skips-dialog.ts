import { DOCUMENT } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  inject,
  output,
  viewChild,
} from '@angular/core';
import {
  MEDIA_SKIP_BACK_SECONDS,
  MEDIA_SKIP_FORWARD_SECONDS,
} from '@kb-chat/contracts';
import {
  ListeningPreferences,
  type SkipBackSeconds,
  type SkipForwardSeconds,
} from '@core/media/listening-preferences.js';

/**
 * "Pulos" (screens.md T15, KBC-043): how far "Voltar" and "Avançar" go, as two labelled
 * groups of radio buttons, applied at once and kept on the account for every media and
 * device. Esc and "Fechar" close it; the focus goes back to where it was.
 */
@Component({
  selector: 'app-skips-dialog',
  template: `
    <dialog
      #dialog
      class="dialog"
      aria-labelledby="skips-title"
      (close)="closed.emit()"
    >
      <h2 id="skips-title" i18n="@@player.skips.title">Pulos</h2>
      <fieldset>
        <legend i18n="@@player.skips.back">Voltar</legend>
        @for (seconds of backChoices; track seconds) {
          <label class="choice">
            <input
              type="radio"
              name="skip-back"
              [value]="seconds"
              [checked]="preferences.value().skipBackSec === seconds"
              (change)="chooseBack(seconds)"
            />
            <span i18n="@@player.skips.seconds">{{ seconds }} s</span>
          </label>
        }
      </fieldset>
      <fieldset>
        <legend i18n="@@player.skips.forward">Avançar</legend>
        @for (seconds of forwardChoices; track seconds) {
          <label class="choice">
            <input
              type="radio"
              name="skip-forward"
              [value]="seconds"
              [checked]="preferences.value().skipForwardSec === seconds"
              (change)="chooseForward(seconds)"
            />
            <span i18n="@@player.skips.seconds">{{ seconds }} s</span>
          </label>
        }
      </fieldset>
      <button
        type="button"
        class="close"
        (click)="close()"
        i18n="@@player.skips.close"
      >
        Fechar
      </button>
    </dialog>
  `,
  styleUrl: './player-dialog.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SkipsDialog {
  protected readonly preferences = inject(ListeningPreferences);
  private readonly document = inject(DOCUMENT);
  private readonly dialog =
    viewChild.required<ElementRef<HTMLDialogElement>>('dialog');
  private opener: HTMLElement | null = null;

  readonly closed = output();

  protected readonly backChoices = MEDIA_SKIP_BACK_SECONDS;
  protected readonly forwardChoices = MEDIA_SKIP_FORWARD_SECONDS;

  /** Every way out (Fechar, Esc) gives the focus back to where it was. */
  constructor() {
    this.closed.subscribe(() => this.opener?.focus());
  }

  open(): void {
    const active = this.document.activeElement;
    this.opener = active instanceof HTMLElement ? active : null;
    const dialog = this.dialog().nativeElement;
    dialog.showModal();
    // The focus starts on the current choice, not on the first option.
    dialog
      .querySelector<HTMLInputElement>('input[name="skip-back"]:checked')
      ?.focus();
  }

  protected close(): void {
    this.dialog().nativeElement.close();
  }

  protected chooseBack(seconds: SkipBackSeconds): void {
    this.preferences.setSkipBack(seconds);
  }

  protected chooseForward(seconds: SkipForwardSeconds): void {
    this.preferences.setSkipForward(seconds);
  }
}
