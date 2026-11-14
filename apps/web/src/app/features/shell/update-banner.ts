import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { AppVersion } from '@core/app-version/app-version.js';

/**
 * "Nova versão disponível." (KBC-123 AC-2): a newer app is deployed while something here is
 * in progress, so the page waits for "Atualizar". It floats at the top, over no control of
 * the question box at the bottom, and never moves the page under the person's typing. On a
 * phone it covers the top bar, so "Agora não" (×) closes it for that version.
 */
@Component({
  selector: 'app-update-banner',
  template: `
    <!-- Only while shown: the page's own status region stays the only one otherwise. -->
    @if (version.updateAvailable()) {
      <div class="notice" role="status">
        <p i18n="@@update.available">Nova versão disponível.</p>
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
          (click)="version.dismiss()"
          aria-label="Agora não"
          i18n-aria-label="@@update.dismiss"
        >
          <span aria-hidden="true">×</span>
        </button>
      </div>
    }
  `,
  styleUrl: './update-banner.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class UpdateBanner {
  protected readonly version = inject(AppVersion);
}
