import {
  HttpClient,
  provideHttpClient,
  withInterceptors,
} from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
} from '@angular/common/http/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { aMe, anOwner } from '../../testing/session-fixtures.js';
import { CSRF, authInterceptor } from './auth-interceptor.js';
import { RELOAD_PAGE, SessionStore } from './session-store.js';

const reload = vi.fn();
const UNAUTHORIZED = { status: 401, statusText: 'Unauthorized' };
const unauthenticated = { error: { code: 'UNAUTHENTICATED', message: 'x' } };

function setup() {
  reload.mockReset();
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      provideHttpClient(withInterceptors([authInterceptor])),
      provideHttpClientTesting(),
      { provide: RELOAD_PAGE, useValue: reload },
    ],
  });
  return {
    session: TestBed.inject(SessionStore),
    http: TestBed.inject(HttpTestingController),
    client: TestBed.inject(HttpClient),
  };
}

describe('SessionStore (KBC-010 FR-2)', () => {
  it('is signed in after /me and answers permission checks from it', () => {
    const { session, http } = setup();
    expect(session.can('research')).toBe(true);

    session.start();
    http.expectOne('/api/v1/me').flush(aMe());

    expect(session.state().kind).toBe('signed-in');
    expect(session.can('search')).toBe(true);
    expect(session.can('research')).toBe(false);
    expect(session.isMaster()).toBe(false);
  });

  it('is signed out when /me answers 401, without reloading the page', () => {
    const { session, http } = setup();
    session.start();
    http.expectOne('/api/v1/me').flush(unauthenticated, UNAUTHORIZED);

    expect(session.state().kind).toBe('signed-out');
    expect(reload).not.toHaveBeenCalled();
  });

  it('tells a not-invited account apart from a failed sign-in', () => {
    const { session, http } = setup();
    session.signIn('credential-1').subscribe();
    http
      .expectOne('/api/v1/auth/google')
      .flush(
        { error: { code: 'NOT_INVITED', message: 'x' } },
        { status: 403, statusText: 'Forbidden' },
      );
    expect(session.state().kind).toBe('not-invited');

    session.reset();
    session.signIn('credential-2').subscribe();
    http
      .expectOne('/api/v1/auth/google')
      .flush(
        { error: { code: 'AUTH_UNAVAILABLE', message: 'x' } },
        { status: 503, statusText: 'x' },
      );
    expect(session.state()).toEqual({
      kind: 'failed',
      code: 'AUTH_UNAVAILABLE',
    });

    session.signIn('credential-3').subscribe();
    http.expectOne('/api/v1/auth/google').flush(anOwner());
    expect(session.me()?.email).toBe('owner@example.com');
    expect(session.isMaster()).toBe(true);
  });

  it('signs out and starts the page over, so nothing of this person stays (BR-6)', () => {
    const { session, http } = setup();
    session.signIn('credential').subscribe();
    http.expectOne('/api/v1/auth/google').flush(anOwner());

    session.signOut().subscribe();
    const logout = http.expectOne('/api/v1/auth/logout');
    expect(logout.request.headers.get('x-requested-with')).toBe('kb-chat');
    logout.flush(null, { status: 204, statusText: 'No Content' });

    expect(session.state().kind).toBe('signed-out');
    expect(reload).toHaveBeenCalledTimes(1);
  });
});

describe('authInterceptor', () => {
  it('sends the header the API expects (the contracts value)', async () => {
    const contracts = await import('@kb-chat/contracts');
    expect(CSRF).toEqual({
      header: contracts.CSRF_HEADER,
      value: contracts.CSRF_HEADER_VALUE,
    });
  });

  it('sends the CSRF header on state changes only', () => {
    const { http, client } = setup();
    client.get('/api/v1/topics').subscribe();
    client.put('/api/v1/settings', {}).subscribe();

    expect(
      http.expectOne('/api/v1/topics').request.headers.has('x-requested-with'),
    ).toBe(false);
    expect(
      http
        .expectOne('/api/v1/settings')
        .request.headers.get('x-requested-with'),
    ).toBe('kb-chat');
  });

  it('ends the session when any call answers 401 (revoked, expired)', () => {
    const { session, http, client } = setup();
    session.start();
    http.expectOne('/api/v1/me').flush(aMe());

    client.get('/api/v1/topics').subscribe({ error: () => undefined });
    http.expectOne('/api/v1/topics').flush(unauthenticated, UNAUTHORIZED);

    expect(session.state().kind).toBe('signed-out');
    expect(reload).toHaveBeenCalledTimes(1);
  });
});
