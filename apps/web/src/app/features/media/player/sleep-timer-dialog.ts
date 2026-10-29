import { DOCUMENT } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  inject,
  output,
  viewChild,
} from '@angular/core';
import { SLEEP_MINUTES, type SleepMinutes } from '@kb-chat/player-core';
import { SleepTimerService } from '@core/media/sleep-timer.js';

/**
 * "Timer para dormir" (screens.md T15, KBC-046): 5 to 60 minutes or "No fim desta mídia".
 * A choice starts the timer and closes the dialog; Esc and "Fechar" close it too, and the
 * focus goes back to where it was.
 */
@Component({
  selector: 'app-sleep-timer-dialog',
  template: `
    <dialog
      #dialog
      class="dialog"
      aria-labelledby="sleep-title"
      (close)="closed.emit()"
    >
      <h2 id="sleep-title" i18n="@@sleep.title">Timer para dormir</h2>
      <fieldset>
        <legend i18n="@@sleep.stopAfter">Parar depois de</legend>
        @for (minutes of choices; track minutes) {
          <label class="choice">
            <input type="radio" name="sleep-timer" (change)="choose(minutes)" />
            <span i18n="@@sleep.minutes">{{ minutes }} min</span>
          </label>
        }
        <label class="choice">
          <input
            type="radio"
            name="sleep-timer"
            (change)="choose('end-of-media')"
          />
          <span i18n="@@sleep.endOfMedia">No fim desta mídia</span>
        </label>
      </fieldset>
      <button
        type="button"
        class="close"
        (click)="close()"
        i18n="@@sleep.close"
      >
        Fechar
      </button>
    </dialog>
  `,
  styleUrl: './player-dialog.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SleepTimerDialog {
  private readonly timer = inject(SleepTimerService);
  private readonly document = inject(DOCUMENT);
  private readonly dialog =
    viewChild.required<ElementRef<HTMLDialogElement>>('dialog');
  private opener: HTMLElement | null = null;

  readonly closed = output();

  protected readonly choices = SLEEP_MINUTES;

  /** Every way out (a choice, Fechar, Esc) gives the focus back to where it was. */
  constructor() {
    this.closed.subscribe(() => this.opener?.focus());
  }

  open(): void {
    const active = this.document.activeElement;
    this.opener = active instanceof HTMLElement ? active : null;
    this.dialog().nativeElement.showModal();
  }

  protected close(): void {
    this.dialog().nativeElement.close();
  }

  protected choose(choice: SleepMinutes | 'end-of-media'): void {
    this.timer.start(choice);
    this.close();
  }
}
