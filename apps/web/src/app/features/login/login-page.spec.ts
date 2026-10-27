import { provideRouter } from '@angular/router';
import { provideHttpClient } from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
} from '@angular/common/http/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { fireEvent, render, screen } from '@testing-library/angular';
import {
  GoogleIdentity,
  type GoogleAccountsId,
} from '@core/auth/google-identity.js';
import { RELOAD_PAGE, SessionStore } from '@core/auth/session-store.js';
import { of, throwError, type Observable } from 'rxjs';
import { aMe } from '../../testing/session-fixtures.js';
import { LoginPage } from './login-page.js';

type Callback = (response: { credential?: string }) => void;

function fakeGoogle() {
  const calls = {
    clientId: '',
    callback: null as Callback | null,
    rendered: 0,
    autoSelectOff: 0,
  };
  const accounts: GoogleAccountsId = {
    initialize: (options) => {
      calls.clientId = options.client_id;
      calls.callback = options.callback;
    },
    renderButton: (parent) => {
      calls.rendered += 1;
      parent.textContent = 'Fazer login com o Google';
    },
    disableAutoSelect: () => {
      calls.autoSelectOff += 1;
    },
  };
  return { calls, accounts };
}

async function renderLogin(
  accounts$: Observable<GoogleAccountsId>,
  disable = () => undefined,
) {
  const result = await render(LoginPage, {
    providers: [
      provideZonelessChangeDetection(),
      provideRouter([]),
      provideHttpClient(),
      provideHttpClientTesting(),
      {
        provide: GoogleIdentity,
        useValue: { accounts$, disableAutoSelect: disable },
      },
      { provide: RELOAD_PAGE, useValue: () => undefined },
    ],
  });
  return { ...result, http: TestBed.inject(HttpTestingController) };
}

describe('LoginPage (KBC-010, T8)', () => {
  it('renders the Google button with the configured client id and signs in with its credential', async () => {
    const google = fakeGoogle();
    const { http, fixture } = await renderLogin(of(google.accounts));
    http.expectOne('/api/v1/auth/config').flush({
      googleClientId: 'client-123',
      codeChannels: ['email'],
      privacyContactEmail: null,
    });
    await fixture.whenStable();

    expect(google.calls.clientId).toBe('client-123');
    expect(google.calls.rendered).toBeGreaterThan(0);
    expect(screen.getByText('Fazer login com o Google')).toBeTruthy();

    google.calls.callback?.({ credential: 'google-id-token' });
    await fixture.whenStable();
    expect(screen.getByRole('status').textContent).toContain('Entrando');
    const login = http.expectOne('/api/v1/auth/google');
    expect(login.request.body).toEqual({ credential: 'google-id-token' });
    login.flush(aMe());
    await fixture.whenStable();

    expect(TestBed.inject(SessionStore).state().kind).toBe('signed-in');
  });

  it('AC-2: tells a not-invited account to ask a master, with "Sair"', async () => {
    const google = fakeGoogle();
    const disable = vi.fn();
    const { http, fixture } = await renderLogin(of(google.accounts), disable);
    http.expectOne('/api/v1/auth/config').flush({
      googleClientId: 'client-123',
      codeChannels: ['email'],
      privacyContactEmail: null,
    });
    await fixture.whenStable();

    google.calls.callback?.({ credential: 'google-id-token' });
    http
      .expectOne('/api/v1/auth/google')
      .flush(
        { error: { code: 'NOT_INVITED', message: 'x' } },
        { status: 403, statusText: 'Forbidden' },
      );
    await fixture.whenStable();

    expect(
      screen.getByText('Seu acesso ainda não foi liberado; peça a um master.'),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Sair' }));
    await fixture.whenStable();
    expect(disable).toHaveBeenCalled();
    expect(
      screen.queryByText(
        'Seu acesso ainda não foi liberado; peça a um master.',
      ),
    ).toBeNull();
  });

  it('shows a sign-in failure next to the button', async () => {
    const google = fakeGoogle();
    const { http, fixture } = await renderLogin(of(google.accounts));
    http.expectOne('/api/v1/auth/config').flush({
      googleClientId: 'client-123',
      codeChannels: ['email'],
      privacyContactEmail: null,
    });
    await fixture.whenStable();

    google.calls.callback?.({ credential: 'google-id-token' });
    http
      .expectOne('/api/v1/auth/google')
      .flush(
        { error: { code: 'AUTH_UNAVAILABLE', message: 'x' } },
        { status: 503, statusText: 'x' },
      );
    await fixture.whenStable();

    expect(screen.getByRole('alert').textContent).toContain(
      'Não consegui confirmar o login com o Google',
    );
  });

  it('explains a missing client id', async () => {
    const { http, fixture } = await renderLogin(of(fakeGoogle().accounts));
    http.expectOne('/api/v1/auth/config').flush({
      googleClientId: null,
      codeChannels: ['email'],
      privacyContactEmail: null,
    });
    await fixture.whenStable();

    expect(screen.getByRole('alert').textContent).toContain('GOOGLE_CLIENT_ID');
  });

  it('offers to try again when the Google script does not load', async () => {
    const { http, fixture } = await renderLogin(
      throwError(() => new Error('blocked')),
    );
    http.expectOne('/api/v1/auth/config').flush({
      googleClientId: 'client-123',
      codeChannels: ['email'],
      privacyContactEmail: null,
    });
    await fixture.whenStable();

    expect(screen.getByRole('alert').textContent).toContain(
      'Não consegui carregar o botão do Google',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Tentar de novo' }));
    http.expectOne('/api/v1/auth/config').flush({
      googleClientId: 'client-123',
      codeChannels: ['email'],
      privacyContactEmail: null,
    });
  });

  it('links to the public privacy policy (KBC-016)', async () => {
    const google = fakeGoogle();
    const { http, fixture } = await renderLogin(of(google.accounts));
    http.expectOne('/api/v1/auth/config').flush({
      googleClientId: 'client-123',
      codeChannels: ['email'],
      privacyContactEmail: null,
    });
    await fixture.whenStable();

    expect(
      screen.getByRole('link', { name: 'Privacidade' }).getAttribute('href'),
    ).toBe('/privacidade');
  });

  it('links to the public tutorial (KBC-032 AC-4)', async () => {
    const google = fakeGoogle();
    const { http, fixture } = await renderLogin(of(google.accounts));
    http.expectOne('/api/v1/auth/config').flush({
      googleClientId: 'client-123',
      codeChannels: ['email'],
      privacyContactEmail: null,
    });
    await fixture.whenStable();

    expect(
      screen.getByRole('link', { name: 'Como usar' }).getAttribute('href'),
    ).toBe('/tutorial');
  });
});
