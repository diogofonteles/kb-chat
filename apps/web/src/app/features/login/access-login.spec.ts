import { provideHttpClient } from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
} from '@angular/common/http/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { fireEvent, render, screen } from '@testing-library/angular';
import type { CodeChannel } from '@kb-chat/contracts';
import {
  GoogleIdentity,
  type GoogleAccountsId,
} from '@core/auth/google-identity.js';
import { RELOAD_PAGE, SessionStore } from '@core/auth/session-store.js';
import { of } from 'rxjs';
import { aMe } from '../../testing/session-fixtures.js';
import { LoginPage } from './login-page.js';

type Callback = (response: { credential?: string }) => void;

async function renderLogin(codeChannels: CodeChannel[] = ['email']) {
  let callback: Callback | null = null;
  const accounts: GoogleAccountsId = {
    initialize: (options) => (callback = options.callback),
    renderButton: () => undefined,
    disableAutoSelect: () => undefined,
  };
  const result = await render(LoginPage, {
    providers: [
      provideZonelessChangeDetection(),
      provideHttpClient(),
      provideHttpClientTesting(),
      {
        provide: GoogleIdentity,
        useValue: {
          accounts$: of(accounts),
          disableAutoSelect: () => undefined,
        },
      },
      { provide: RELOAD_PAGE, useValue: () => undefined },
    ],
  });
  const http = TestBed.inject(HttpTestingController);
  http
    .expectOne('/api/v1/auth/config')
    .flush({ googleClientId: 'client-1', codeChannels });
  await result.fixture.whenStable();
  return { ...result, http, google: () => callback };
}

const button = (name: string | RegExp) => screen.getByRole('button', { name });
const type = (label: string, value: string) =>
  fireEvent.input(screen.getByLabelText(label), { target: { value } });

describe('Entrar com código (KBC-014 FR-5, T10)', () => {
  it('AC-12: without an SMS provider asks only for the email, then signs in with the code', async () => {
    const { http, fixture } = await renderLogin();

    fireEvent.click(button('Entrar com código'));
    await fixture.whenStable();
    expect(screen.queryByRole('radio')).toBeNull();
    type('E-mail', 'ana@example.com');
    fireEvent.click(button('Enviar código'));
    const send = http.expectOne('/api/v1/auth/code');
    expect(send.request.body).toEqual({
      identifier: 'ana@example.com',
      channel: 'email',
    });
    send.flush({}, { status: 202, statusText: 'Accepted' });
    await fixture.whenStable();

    expect(
      screen.getByText(/Se houver um acesso para ana@example.com/),
    ).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByLabelText('Código'));
    type('Código', '12a3456');
    fireEvent.click(button('Entrar'));
    const verify = http.expectOne('/api/v1/auth/code/verify');
    expect(verify.request.body).toEqual({
      identifier: 'ana@example.com',
      code: '123456',
    });
    verify.flush(aMe({ email: 'ana@example.com' }));
    await fixture.whenStable();

    expect(TestBed.inject(SessionStore).state().kind).toBe('signed-in');
  });

  it('shows a wrong code and a bad email at the field, in plain words', async () => {
    const { http, fixture } = await renderLogin();
    fireEvent.click(button('Entrar com código'));
    await fixture.whenStable();

    type('E-mail', 'ana@');
    fireEvent.click(button('Enviar código'));
    await fixture.whenStable();
    expect(screen.getByRole('alert').textContent).toContain(
      'Digite um e-mail válido',
    );
    http.expectNone('/api/v1/auth/code');

    type('E-mail', 'ana@example.com');
    fireEvent.click(button('Enviar código'));
    http.expectOne('/api/v1/auth/code').flush({});
    await fixture.whenStable();
    type('Código', '000000');
    fireEvent.click(button('Entrar'));
    http
      .expectOne('/api/v1/auth/code/verify')
      .flush(
        { error: { code: 'INVALID_CODE', message: 'x' } },
        { status: 400, statusText: 'Bad Request' },
      );
    await fixture.whenStable();

    expect(screen.getByRole('alert').textContent).toContain(
      'Esse código não confere ou já venceu',
    );
  });

  it('offers SMS when it is configured and sends the phone as typed', async () => {
    const { http, fixture } = await renderLogin(['email', 'sms']);
    fireEvent.click(button('Entrar com código'));
    await fixture.whenStable();

    fireEvent.click(screen.getByRole('radio', { name: 'SMS' }));
    await fixture.whenStable();
    type('Celular', '(81) 99999-0000');
    fireEvent.click(button('Enviar código'));
    expect(http.expectOne('/api/v1/auth/code').request.body).toEqual({
      identifier: '(81) 99999-0000',
      channel: 'sms',
    });
  });

  it('tells about too many asks without blaming searches', async () => {
    const { http, fixture } = await renderLogin();
    fireEvent.click(button('Entrar com código'));
    await fixture.whenStable();
    type('E-mail', 'ana@example.com');
    fireEvent.click(button('Enviar código'));
    http
      .expectOne('/api/v1/auth/code')
      .flush(
        { error: { code: 'RATE_LIMITED', message: 'x' } },
        { status: 429, statusText: 'Too Many' },
      );
    await fixture.whenStable();

    expect(screen.getByRole('alert').textContent).toContain(
      'Muitos pedidos em pouco tempo',
    );
    fireEvent.click(button('← Voltar'));
    await fixture.whenStable();
    expect(button('Entrar com código')).toBeTruthy();
  });
});

describe('Pedir acesso sem conta Google (KBC-014 FR-1, FR-2, T10)', () => {
  it('AC-11: checks every field before sending, phone included', async () => {
    const { http, fixture } = await renderLogin();
    fireEvent.click(button('Pedir acesso sem conta Google'));
    await fixture.whenStable();

    type('Celular', '1234');
    fireEvent.click(button('Enviar código'));
    await fixture.whenStable();

    const alerts = screen.getAllByRole('alert').map((a) => a.textContent ?? '');
    expect(alerts.join(' ')).toContain('Digite um e-mail válido');
    expect(alerts.join(' ')).toContain('Digite seu nome.');
    expect(alerts.join(' ')).toContain('Digite seu sobrenome.');
    expect(alerts.join(' ')).toContain('Digite o celular com DDD.');
    expect(screen.getByLabelText('Celular').getAttribute('aria-invalid')).toBe(
      'true',
    );
    http.expectNone('/api/v1/access-requests/signup');
  });

  it('AC-1: sends the form, confirms the email code and says a master will decide', async () => {
    const { http, fixture } = await renderLogin();
    fireEvent.click(button('Pedir acesso sem conta Google'));
    await fixture.whenStable();
    type('E-mail', 'ana@example.com');
    type('Nome', 'Ana');
    type('Sobrenome', 'Lima');
    type('Celular', '(81) 99999-0000');

    fireEvent.click(button('Enviar código'));
    const signUp = http.expectOne('/api/v1/access-requests/signup');
    expect(signUp.request.body).toEqual({
      email: 'ana@example.com',
      firstName: 'Ana',
      lastName: 'Lima',
      phone: '(81) 99999-0000',
    });
    signUp.flush({});
    await fixture.whenStable();
    expect(
      screen.getByText(/Se o e-mail puder ser usado, enviamos um código/),
    ).toBeTruthy();

    type('Código', '123456');
    fireEvent.click(button('Confirmar'));
    const confirm = http.expectOne('/api/v1/access-requests/signup/verify');
    expect(confirm.request.body).toEqual({
      email: 'ana@example.com',
      code: '123456',
    });
    confirm.flush({ status: 'pending' });
    await fixture.whenStable();

    expect(
      screen.getByText(/Solicitação enviada. Um master vai analisar/),
    ).toBeTruthy();
  });

  it('points an email that already has access back to the sign-in', async () => {
    const { http, fixture } = await renderLogin();
    fireEvent.click(button('Pedir acesso sem conta Google'));
    await fixture.whenStable();
    type('E-mail', 'ana@example.com');
    type('Nome', 'Ana');
    type('Sobrenome', 'Lima');
    type('Celular', '81999990000');
    fireEvent.click(button('Enviar código'));
    http.expectOne('/api/v1/access-requests/signup').flush({});
    await fixture.whenStable();
    type('Código', '123456');
    fireEvent.click(button('Confirmar'));
    http
      .expectOne('/api/v1/access-requests/signup/verify')
      .flush(
        { error: { code: 'ALREADY_INVITED', message: 'x' } },
        { status: 409, statusText: 'Conflict' },
      );
    await fixture.whenStable();

    expect(screen.getByRole('alert').textContent).toContain(
      'Este e-mail já tem acesso',
    );
    fireEvent.click(button('Trocar e-mail'));
    await fixture.whenStable();
    expect((screen.getByLabelText('E-mail') as HTMLInputElement).value).toBe(
      'ana@example.com',
    );
  });
});

describe('Google sem convite (KBC-014 FR-3, T8)', () => {
  const notInvited = (request: object) => ({
    error: {
      code: 'NOT_INVITED',
      message: 'x',
      details: { ticket: 't'.repeat(40), request },
    },
  });

  async function signInNotInvited(request: object) {
    const started = await renderLogin();
    started.google()?.({ credential: 'google-id-token' });
    started.http
      .expectOne('/api/v1/auth/google')
      .flush(notInvited(request), { status: 403, statusText: 'Forbidden' });
    await started.fixture.whenStable();
    return started;
  }

  it('AC-8: asks for access with the ticket and an optional phone', async () => {
    const { http, fixture } = await signInNotInvited({ status: 'none' });
    expect(screen.getByRole('alert').textContent).toContain(
      'Seu acesso ainda não foi liberado.',
    );

    fireEvent.click(button('Solicitar acesso'));
    await fixture.whenStable();
    fireEvent.click(button('Enviar solicitação'));
    const request = http.expectOne('/api/v1/access-requests/google');
    expect(request.request.body).toEqual({ ticket: 't'.repeat(40) });
    request.flush(
      { status: 'pending' },
      { status: 201, statusText: 'Created' },
    );
    await fixture.whenStable();

    expect(
      screen.getByText(/Solicitação enviada. Você recebe um e-mail/),
    ).toBeTruthy();
    expect(button('Sair')).toBeTruthy();
  });

  it('refuses a bad optional phone and explains an expired ticket', async () => {
    const { http, fixture } = await signInNotInvited({ status: 'none' });
    fireEvent.click(button('Solicitar acesso'));
    await fixture.whenStable();

    type('Celular (opcional)', '12');
    fireEvent.click(button('Enviar solicitação'));
    await fixture.whenStable();
    expect(screen.getByText(/Digite o celular com DDD/)).toBeTruthy();
    http.expectNone('/api/v1/access-requests/google');

    type('Celular (opcional)', '81988887777');
    fireEvent.click(button('Enviar solicitação'));
    const request = http.expectOne('/api/v1/access-requests/google');
    expect(request.request.body).toEqual({
      ticket: 't'.repeat(40),
      phone: '81988887777',
    });
    request.flush(
      { error: { code: 'REQUEST_EXPIRED', message: 'x' } },
      { status: 400, statusText: 'Bad' },
    );
    await fixture.whenStable();
    expect(
      screen.getByText(/Esta tela ficou aberta tempo demais/),
    ).toBeTruthy();
  });

  it('says a request is pending, or refused with the time to ask again', async () => {
    await signInNotInvited({ status: 'pending' });
    expect(screen.getByRole('alert').textContent).toContain(
      'Sua solicitação está em análise.',
    );
    expect(
      screen.queryByRole('button', { name: 'Solicitar acesso' }),
    ).toBeNull();
  });

  it('shows when a refused person may ask again', async () => {
    await signInNotInvited({
      status: 'refused',
      retryAt: '2026-10-26T13:30:00.000Z',
    });
    expect(screen.getByRole('alert').textContent).toMatch(
      /recusada.*a partir de 26\/10 às \d\d:30/s,
    );
  });
});
