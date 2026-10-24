import { ChangeDetectionStrategy, Component } from '@angular/core';
import { SessionShell } from '@features/shell/session-shell.js';

/**
 * The root: the session shell (login or the app) loads in its own chunk, so the first
 * bundle stays small; "Carregando…" shows meanwhile.
 */
@Component({
  selector: 'app-root',
  imports: [SessionShell],
  template: `
    @defer (on immediate) {
      <app-session-shell />
    } @placeholder {
      <p class="boot" role="status" i18n="@@app.loading">Carregando…</p>
    }
  `,
  styles: `
    .boot {
      margin: 0;
      padding: var(--space-8);
      text-align: center;
      color: var(--color-text-muted);
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class App {}
