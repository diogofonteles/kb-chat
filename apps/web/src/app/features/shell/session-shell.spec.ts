import { provideHttpClient, withInterceptors } from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
} from '@angular/common/http/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter, Router, type Routes } from '@angular/router';
import { render, screen } from '@testing-library/angular';
import { authInterceptor } from '@core/auth/auth-interceptor.js';
import { GoogleIdentity } from '@core/auth/google-identity.js';
import { RELOAD_PAGE } from '@core/auth/session-store.js';
import { of } from 'rxjs';
import { routes } from '../../app.routes.js';
import { anOwner } from '../../testing/session-fixtures.js';
import { SessionShell } from './session-shell.js';

const CONFIG = {
  googleClientId: 'client',
  codeChannels: ['email'],
  privacyContactEmail: null,
};

async function renderApp(appRoutes: Routes = []) {
  const result = await render(SessionShell, {
    providers: [
      provideZonelessChangeDetection(),
      provideRouter(appRoutes),
      provideHttpClient(withInterceptors([authInterceptor])),
      provideHttpClientTesting(),
      {
        provide: GoogleIdentity,
        useValue: {
          accounts$: of({
            initialize: () => undefined,
            renderButton: () => undefined,
            disableAutoSelect: () => undefined,
          }),
        },
      },
      { provide: RELOAD_PAGE, useValue: () => undefined },
    ],
  });
  return { ...result, http: TestBed.inject(HttpTestingController) };
}

describe('SessionShell (KBC-010 BR-1)', () => {
  it('waits for /me, then shows the app to a signed-in person', async () => {
    const { container, http, fixture } = await renderApp();
    expect(screen.getByRole('status').textContent).toContain('Carregando');

    http.expectOne('/api/v1/me').flush(anOwner());
    await fixture.whenStable();

    expect(container.querySelector('router-outlet')).toBeTruthy();
    expect(routes[0]?.path).toBe('');
  });

  it('shows "Entrar com Google" when nobody is signed in', async () => {
    const { container, http, fixture } = await renderApp();

    http
      .expectOne('/api/v1/me')
      .flush(
        { error: { code: 'UNAUTHENTICATED', message: 'x' } },
        { status: 401, statusText: 'Unauthorized' },
      );
    TestBed.tick();
    http.expectOne('/api/v1/auth/config').flush({ googleClientId: 'client' });
    await fixture.whenStable();

    expect(container.querySelector('router-outlet')).toBeNull();
    expect(
      screen.getByRole('heading', { level: 1, name: 'Nova Alexandria' }),
    ).toBeTruthy();
    expect(
      screen.getByText(
        'Suas conversas e configurações ficam no servidor da Nova Alexandria.',
      ),
    ).toBeTruthy();
  });

  it('shows the privacy policy at /privacidade without a session (KBC-016)', async () => {
    const { http, fixture } = await renderApp(routes);
    http
      .expectOne('/api/v1/me')
      .flush(
        { error: { code: 'UNAUTHENTICATED', message: 'x' } },
        { status: 401, statusText: 'Unauthorized' },
      );
    TestBed.tick();
    http.expectOne('/api/v1/auth/config').flush(CONFIG);
    await fixture.whenStable();

    expect(await TestBed.inject(Router).navigateByUrl('/privacidade')).toBe(
      true,
    );
    await vi.waitFor(() => http.expectOne('/api/v1/auth/config').flush(CONFIG));
    await fixture.whenStable();

    expect(
      screen.getByRole('heading', {
        level: 1,
        name: 'Política de privacidade',
      }),
    ).toBeTruthy();
    expect(
      screen.queryByRole('heading', { level: 1, name: 'Nova Alexandria' }),
    ).toBeNull();
  });
});
