import { Location } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
} from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { NavigationEnd, Router, RouterOutlet } from '@angular/router';
import { SessionStore } from '@core/auth/session-store.js';
import { isPublicUrl } from '@core/routing/public-pages.js';
import { filter, map } from 'rxjs';
import { LoginPage } from '@features/login/login-page.js';
import { SettingsHost } from '@features/settings/settings-host.js';

/**
 * Who is signed in decides between the login screen and the app (KBC-010 BR-1); a public
 * page (the privacy policy, KBC-016) shows either way. Settings load in their own chunk,
 * right after the first paint.
 */
@Component({
  selector: 'app-session-shell',
  imports: [RouterOutlet, SettingsHost, LoginPage],
  template: `
    @if (publicPage()) {
      <router-outlet />
    } @else if (signedIn()) {
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
  private readonly router = inject(Router);
  protected readonly publicPage = toSignal(
    this.router.events.pipe(
      filter((event) => event instanceof NavigationEnd),
      map((event) => isPublicUrl(event.urlAfterRedirects)),
    ),
    // The first navigation may end before this shell exists: read the address bar.
    { initialValue: isPublicUrl(inject(Location).path()) },
  );
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
