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
import { RELOAD_VIEW, VIEW } from './current-view.js';
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

  it('says whose view the tab writes as: its own, or the person a master acts as (KBC-060)', async () => {
    const contracts = await import('@kb-chat/contracts');
    expect(VIEW).toEqual({
      header: contracts.VIEW_HEADER,
      own: contracts.OWN_VIEW,
    });
    const { session, http, client } = setup();
    client.put('/api/v1/settings', {}).subscribe();
    // Before /me answers, no view is claimed.
    expect(
      http.expectOne('/api/v1/settings').request.headers.has('x-kb-chat-view'),
    ).toBe(false);
    session.start();
    http.expectOne('/api/v1/me').flush(anOwner());
    client.get('/api/v1/topics').subscribe();
    client.put('/api/v1/settings', {}).subscribe();
    expect(
      http.expectOne('/api/v1/topics').request.headers.has('x-kb-chat-view'),
    ).toBe(false);
    expect(
      http.expectOne('/api/v1/settings').request.headers.get('x-kb-chat-view'),
    ).toBe('self');
  });

  it('writes as the person while acting, and reloads when the server has another view', () => {
    const reloadView = vi.fn();
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        provideHttpClient(withInterceptors([authInterceptor])),
        provideHttpClientTesting(),
        { provide: RELOAD_PAGE, useValue: vi.fn() },
        { provide: RELOAD_VIEW, useValue: reloadView },
      ],
    });
    const session = TestBed.inject(SessionStore);
    const http = TestBed.inject(HttpTestingController);
    const client = TestBed.inject(HttpClient);
    session.start();
    const ana = {
      id: '11111111-1111-4111-8111-111111111111',
      name: 'Ana',
      email: 'ana@example.com',
    };
    http.expectOne('/api/v1/me').flush(
      aMe({
        actingAs: {
          person: ana,
          actor: {
            ...ana,
            id: '22222222-2222-4222-8222-222222222222',
            email: 'owner@example.com',
          },
          reason: 'r',
          startedAt: '2026-11-03T12:00:00.000Z',
          endsAt: '2026-11-03T12:30:00.000Z',
          remainingMs: 60_000,
        },
      }),
    );
    client.put('/api/v1/settings', {}).subscribe({ error: () => undefined });
    const write = http.expectOne('/api/v1/settings');
    expect(write.request.headers.get('x-kb-chat-view')).toBe(ana.id);
    write.flush(
      { error: { code: 'VIEW_CHANGED', message: 'x' } },
      { status: 409, statusText: 'Conflict' },
    );
    expect(reloadView).toHaveBeenCalledOnce();
  });
});
