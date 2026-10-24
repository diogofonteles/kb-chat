import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
} from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { SessionStore } from '@core/auth/session-store.js';
import { LoginPage } from '@features/login/login-page.js';
import { SettingsHost } from '@features/settings/settings-host.js';

/**
 * Who is signed in decides between the login screen and the app (KBC-010 BR-1). Settings
 * load in their own chunk, right after the first paint.
 */
@Component({
  selector: 'app-session-shell',
  imports: [RouterOutlet, SettingsHost, LoginPage],
  template: `
    @if (signedIn()) {
      <router-outlet />
      @defer (on immediate) {
        <app-settings-host />
      }
    } @else if (deciding()) {
      <p class="boot" role="status" i18n="@@app.loading">Carregando…</p>
    } @else {
      <app-login-page />
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
export class SessionShell {
  private readonly session = inject(SessionStore);
  protected readonly signedIn = computed(
    () => this.session.state().kind === 'signed-in',
  );
  protected readonly deciding = computed(
    () => this.session.state().kind === 'loading',
  );

  constructor() {
    this.session.start();
  }
}
