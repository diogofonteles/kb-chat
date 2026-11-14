import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { AppVersion } from '@core/app-version/app-version.js';

/**
 * "Nova versão disponível." (KBC-123 AC-2): a newer app is deployed while something here is
 * in progress, so the page waits for "Atualizar". It floats under the top bar, over none
 * of its controls nor the question box at the bottom, and never moves the page under the
 * person's typing. "Agora não" (×) closes it for that version.
 */
@Component({
  selector: 'app-update-banner',
  template: `
    <!-- The live region is always there, empty, so the text put in it is announced. -->
    <div
      class="notice"
      [class.shown]="shown()"
      (focusin)="rememberFocusFrom($event)"
    >
      <div class="message" role="status">
        @if (shown()) {
          <p i18n="@@update.available">Nova versão disponível.</p>
        }
      </div>
      @if (shown()) {
        <button
          type="button"
          class="reload"
          (click)="version.update()"
          i18n="@@update.reload"
        >
          Atualizar
        </button>
        <button
          type="button"
          class="dismiss"
          (click)="dismiss()"
          aria-label="Agora não"
          i18n-aria-label="@@update.dismiss"
        >
          <span aria-hidden="true">×</span>
        </button>
      }
    </div>
  `,
  styleUrl: './update-banner.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class UpdateBanner {
  protected readonly version = inject(AppVersion);
  protected readonly shown = this.version.updateAvailable;
  /** Where the focus came from into the notice: it goes back there when the notice closes. */
  private focusedBefore: HTMLElement | null = null;

  protected rememberFocusFrom(event: FocusEvent): void {
    const from = event.relatedTarget;
    const notice = event.currentTarget;
    if (
      from instanceof HTMLElement &&
      notice instanceof HTMLElement &&
      !notice.contains(from)
    )
      this.focusedBefore = from;
  }

  /** "Agora não": the closed notice never leaves the focus on nothing (PD-01). */
  protected dismiss(): void {
    this.version.dismiss();
    if (this.focusedBefore?.isConnected) this.focusedBefore.focus();
    this.focusedBefore = null;
  }
}
