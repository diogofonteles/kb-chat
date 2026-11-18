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
import { UiButton, UiDialog, UiIcon } from '@ui/index.js';

/**
 * "Timer para dormir" (screens.md T15, KBC-046): 5 to 60 minutes or "No fim desta mídia".
 * A choice (a button) starts the timer and closes the dialog; Esc, ✕ and "Fechar" close it
 * too, and the focus goes back to where it was. The running one shows by a ✓, never by
 * colour alone.
 */
@Component({
  selector: 'app-sleep-timer-dialog',
  imports: [UiButton, UiDialog, UiIcon],
  template: `
    <!-- v2 modal (player.js over 'sleep'): ✕, "Parar depois de", the choices on one line
         and "Fechar" on the right; a sheet with a list on a phone (mOver 'sleep'). -->
    <ui-dialog
      #dialog
      title="Timer para dormir"
      i18n-title="@@sleep.title"
      titleId="sleep-title"
      [width]="520"
      [top]="280"
      [short]="true"
      (closed)="closed.emit()"
    >
      <!-- Buttons, not radios: an arrow key never starts a timer (WCAG 3.2.2); the running one is current, not pressed (choosing it starts it over). -->
      <div class="choices" role="group" aria-labelledby="sleep-stop-after">
        <p id="sleep-stop-after" class="group-label" i18n="@@sleep.stopAfter">
          Parar depois de
        </p>
        <div class="options">
          @for (minutes of choices; track minutes) {
            <button
              #choice
              type="button"
              class="choice"
              [attr.aria-current]="current() === minutes ? 'true' : null"
              (click)="choose(minutes)"
            >
              <ui-icon class="lead" name="timer" [size]="20" />
              @if (current() === minutes) {
                <span class="on" aria-hidden="true">✓</span>
              }
              <span i18n="@@sleep.minutes">{{ minutes }} min</span>
            </button>
          }
          <button
            type="button"
            class="choice"
            [attr.aria-current]="current() === 'end-of-media' ? 'true' : null"
            (click)="choose('end-of-media')"
          >
            <ui-icon class="moon" name="moon" [size]="16" />
            @if (current() === 'end-of-media') {
              <span class="on" aria-hidden="true">✓</span>
            }
            <span i18n="@@sleep.endOfMedia">No fim desta mídia</span>
          </button>
        </div>
      </div>
      <div uiDialogFooter class="footer">
        <button
          uiButton="ghost"
          type="button"
          class="close"
          (click)="close()"
          i18n="@@sleep.close"
        >
          Fechar
        </button>
      </div>
    </ui-dialog>
  `,
  styleUrl: './sleep-timer-dialog.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SleepTimerDialog {
  private readonly timer = inject(SleepTimerService);
  private readonly document = inject(DOCUMENT);
  private readonly dialog = viewChild.required(UiDialog);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly firstChoice =
    viewChild<ElementRef<HTMLButtonElement>>('choice');
  private opener: HTMLElement | null = null;

  readonly closed = output();

  protected readonly choices = SLEEP_MINUTES;
  /** The running timer's choice, shown as current with ✓ (none while off). */
  protected readonly current = this.timer.choice;

  /**
   * Every way out (a choice, Fechar, Esc) gives the focus back to where it was, unless it already
   * moved on: the close event comes a task later, after the browser may have restored it itself.
   */
  constructor() {
    this.closed.subscribe(() => {
      const active = this.document.activeElement;
      // Still on a choice of the closed dialog, or nowhere: back to where it was.
      const lost =
        !active ||
        active === this.document.body ||
        this.host.nativeElement.contains(active);
      if (lost) this.opener?.focus();
    });
  }

  open(): void {
    const active = this.document.activeElement;
    this.opener = active instanceof HTMLElement ? active : null;
    this.dialog().open();
    // The first choice takes the focus, not the ✕ in the corner (as before v2).
    this.firstChoice()?.nativeElement.focus();
  }

  protected close(): void {
    this.dialog().close();
  }

  protected choose(choice: SleepMinutes | 'end-of-media'): void {
    this.timer.start(choice);
    this.close();
  }
}
