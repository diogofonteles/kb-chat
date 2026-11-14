import {
  ChangeDetectionStrategy,
  Component,
  booleanAttribute,
  inject,
  input,
} from '@angular/core';
import { Router } from '@angular/router';
import { AppVersion } from '@core/app-version/app-version.js';

/**
 * The `@error` of a deferred page (privacy, tutorial, settings): its chunk did not load,
 * most likely because a deploy removed it from under an old tab (KBC-123 AC-5). The app
 * asks for the version at once and, if it is another, loads the same page from the new
 * app. Shown pages also offer to reload by hand; a background block (`quiet`) shows nothing.
 */
@Component({
  selector: 'app-chunk-failed',
  template: `
    @if (!quiet()) {
      <div class="failed" role="alert">
        <p i18n="@@chunkFailed.message">Não consegui abrir esta página.</p>
        <button
          type="button"
          (click)="version.update()"
          i18n="@@chunkFailed.reload"
        >
          Recarregar
        </button>
      </div>
    }
  `,
  styles: `
    .failed {
      display: grid;
      justify-items: center;
      gap: var(--space-3);
      padding: var(--space-8) var(--space-4);
      text-align: center;
      color: var(--color-text-muted);
    }

    p {
      margin: 0;
    }

    button {
      min-height: var(--target);
      padding: 0 var(--space-4);
      border: 1px solid var(--color-border);
      border-radius: var(--radius-sm);
      background: var(--color-surface);
      color: var(--color-text);
      font: inherit;
      cursor: pointer;
    }

    button:focus-visible {
      outline: 3px solid var(--color-focus);
      outline-offset: 2px;
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ChunkFailed {
  protected readonly version = inject(AppVersion);
  readonly quiet = input(false, { transform: booleanAttribute });

  constructor() {
    this.version.check('chunk', inject(Router).url);
  }
}
