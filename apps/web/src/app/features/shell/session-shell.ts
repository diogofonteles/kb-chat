import { Location } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
} from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import {
  NavigationCancel,
  NavigationEnd,
  NavigationError,
  NavigationStart,
  Router,
  RouterOutlet,
} from '@angular/router';
import { SessionStore } from '@core/auth/session-store.js';
import { isPublicUrl } from '@core/routing/public-pages.js';
import { filter, map } from 'rxjs';
import { LoginPage } from '@features/login/login-page.js';
import { PrivacyPage } from '@features/privacy/privacy-page.js';
import { SettingsHost } from '@features/settings/settings-host.js';

/**
 * Who is signed in decides between the login screen and the app (KBC-010 BR-1). A public
 * page (the privacy policy, KBC-016) shows either way, rendered here rather than in the
 * router outlet: the outlet only exists with a session, so a protected page is never built
 * without one. Settings and the policy load in their own chunks.
 */
@Component({
  selector: 'app-session-shell',
  imports: [RouterOutlet, SettingsHost, LoginPage, PrivacyPage],
  template: `
    @if (publicPage()) {
      @defer (on immediate) {
        <app-privacy-page />
      } @placeholder {
        <p class="boot" role="status" i18n="@@app.loading">Carregando…</p>
      }
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
      // Decided as a navigation starts; its end corrects redirects, and a cancelled or
      // failed one falls back to where the router still is.
      filter(
        (event) =>
          event instanceof NavigationStart ||
          event instanceof NavigationEnd ||
          event instanceof NavigationCancel ||
          event instanceof NavigationError,
      ),
      map((event) =>
        isPublicUrl(
          event instanceof NavigationStart
            ? event.url
            : event instanceof NavigationEnd
              ? event.urlAfterRedirects
              : this.router.url,
        ),
      ),
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
