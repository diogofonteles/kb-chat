import { ChangeDetectionStrategy, Component } from '@angular/core';
import { BootScreen } from '@features/shell/boot-screen.js';
import { SessionShell } from '@features/shell/session-shell.js';

/**
 * The root: the session shell (login or the app) loads in its own chunk, so the first
 * bundle stays small; "Carregando…" shows meanwhile.
 */
@Component({
  selector: 'app-root',
  imports: [SessionShell, BootScreen],
  template: `
    @defer (on immediate) {
      <app-session-shell />
    } @placeholder {
      <app-boot-screen />
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class App {}
