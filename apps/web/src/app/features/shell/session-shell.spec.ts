import { provideHttpClient, withInterceptors } from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
} from '@angular/common/http/testing';
import { Component, provideZonelessChangeDetection } from '@angular/core';
import {
  type ComponentFixture,
  DeferBlockState,
  TestBed,
} from '@angular/core/testing';
import { provideRouter, Router, type Routes } from '@angular/router';
import { render, screen } from '@testing-library/angular';
import { authInterceptor } from '@core/auth/auth-interceptor.js';
import { GoogleIdentity } from '@core/auth/google-identity.js';
import { RELOAD_PAGE } from '@core/auth/session-store.js';
import { of } from 'rxjs';
import { routes } from '../../app.routes.js';
import { anOwner } from '../../testing/session-fixtures.js';
import { SessionShell } from './session-shell.js';

/** Stands in for the chat: counts how often a protected page is built. */
let probeBuilt = 0;
@Component({ selector: 'app-probe', template: '<p>protected page</p>' })
class ProtectedProbe {
  constructor() {
    probeBuilt += 1;
  }
}
const probeRoutes: Routes = [
  { path: '', component: ProtectedProbe },
  ...routes.filter(
    (route) => route.path === 'privacidade' || route.path === 'tutorial',
  ),
];

function signOut(http: HttpTestingController): void {
  http
    .expectOne('/api/v1/me')
    .flush(
      { error: { code: 'UNAUTHENTICATED', message: 'x' } },
      { status: 401, statusText: 'Unauthorized' },
    );
  TestBed.tick();
  http.expectOne('/api/v1/auth/config').flush(CONFIG);
}

async function showsPolicy(
  http: HttpTestingController,
  fixture: ComponentFixture<unknown>,
): Promise<void> {
  // The policy loads in its own chunk (@defer): complete the block, then its config call.
  TestBed.tick();
  for (const block of await fixture.getDeferBlocks())
    await block.render(DeferBlockState.Complete);
  TestBed.tick();
  http.expectOne('/api/v1/auth/config').flush(CONFIG);
  await fixture.whenStable();
  expect(
    screen.getByRole('heading', { level: 1, name: 'Política de privacidade' }),
  ).toBeTruthy();
}

const CONFIG = {
  googleClientId: 'client',
  codeChannels: ['email'],
  privacyContactEmail: null,
};

async function renderApp(appRoutes: Routes = []) {
  probeBuilt = 0;
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
    const { http, fixture } = await renderApp(probeRoutes);
    signOut(http);
    await fixture.whenStable();

    expect(await TestBed.inject(Router).navigateByUrl('/privacidade')).toBe(
      true,
    );
    await showsPolicy(http, fixture);

    expect(
      screen.queryByRole('heading', { level: 1, name: 'Nova Alexandria' }),
    ).toBeNull();
    expect(probeBuilt).toBe(0);
  });

  it('shows the tutorial at /tutorial without a session (KBC-032 AC-1)', async () => {
    const { http, fixture } = await renderApp(probeRoutes);
    signOut(http);
    await fixture.whenStable();

    expect(await TestBed.inject(Router).navigateByUrl('/tutorial#entrar')).toBe(
      true,
    );
    TestBed.tick();
    for (const block of await fixture.getDeferBlocks())
      await block.render(DeferBlockState.Complete);
    await fixture.whenStable();

    expect(
      screen.getByRole('heading', {
        level: 1,
        name: 'Como usar a Nova Alexandria',
      }),
    ).toBeTruthy();
    expect(probeBuilt).toBe(0);
  });

  it('never builds a protected page for a signed-out reader leaving the policy (KBC-016)', async () => {
    const { http, fixture } = await renderApp(probeRoutes);
    signOut(http);
    await fixture.whenStable();
    const router = TestBed.inject(Router);
    await router.navigateByUrl('/privacidade');
    await showsPolicy(http, fixture);

    expect(await router.navigateByUrl('/')).toBe(true);
    TestBed.tick();
    http.expectOne('/api/v1/auth/config').flush(CONFIG);
    await fixture.whenStable();

    expect(
      screen.getByRole('heading', { level: 1, name: 'Nova Alexandria' }),
    ).toBeTruthy();
    expect(probeBuilt).toBe(0);
  });

  it('swaps the app for the policy and back for a signed-in person (KBC-016)', async () => {
    const { http, fixture, container } = await renderApp(probeRoutes);
    http.expectOne('/api/v1/me').flush(anOwner());
    await fixture.whenStable();
    const router = TestBed.inject(Router);
    await router.navigateByUrl('/');
    await fixture.whenStable();
    expect(probeBuilt).toBe(1);

    await router.navigateByUrl('/privacidade');
    await showsPolicy(http, fixture);
    expect(container.querySelector('router-outlet')).toBeNull();

    await router.navigateByUrl('/');
    await fixture.whenStable();
    expect(screen.getByText('protected page')).toBeTruthy();
    // Built once on the way in and once on the way back, never twice per visit.
    expect(probeBuilt).toBe(2);
    expect(
      screen.queryByRole('heading', {
        level: 1,
        name: 'Política de privacidade',
      }),
    ).toBeNull();
    http.match(() => true);
  });
});
