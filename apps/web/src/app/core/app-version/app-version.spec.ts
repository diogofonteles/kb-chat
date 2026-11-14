import {
  Component,
  provideZonelessChangeDetection,
  signal,
} from '@angular/core';
import { provideHttpClient } from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
} from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { errorMessage, toUiErrorCode } from '@core/api/api-error.js';
import { AuthApi } from '@core/auth/auth-api.js';
import {
  RELOAD_PAGE,
  SessionStore,
  type SessionState,
} from '@core/auth/session-store.js';
import { GO_TO_URL } from '@core/routing/go-to-url.js';
import { anOwner } from '../../testing/session-fixtures.js';
import {
  APP_VERSION_META,
  AppVersion,
  RELOAD_MARK_KEY,
  VERSION_URL,
  isChunkLoadError,
} from './app-version.js';
import { BusyWork } from './busy-work.js';

@Component({ template: '<p>page</p>' })
class Page {}

const CHUNK_GONE = new TypeError(
  'Failed to fetch dynamically imported module: https://kb.test/chunk-ABCD1234.js',
);

interface Setup {
  readonly meta?: string | null;
  readonly session?: SessionState;
}

function setup({
  meta = 'v1',
  session = { kind: 'signed-in', me: anOwner() },
}: Setup = {}) {
  document.head
    .querySelectorAll(`meta[name="${APP_VERSION_META}"]`)
    .forEach((tag) => tag.remove());
  if (meta) {
    const tag = document.createElement('meta');
    tag.name = APP_VERSION_META;
    tag.content = meta;
    document.head.append(tag);
  }
  const reload = vi.fn();
  const goTo = vi.fn();
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      provideRouter([
        { path: '', component: Page },
        { path: 'login', component: Page },
        { path: 'tutorial', component: Page },
        {
          path: 'midia/:id',
          loadComponent: () => Promise.reject(CHUNK_GONE),
        },
      ]),
      provideHttpClient(),
      provideHttpClientTesting(),
      { provide: RELOAD_PAGE, useValue: reload },
      { provide: GO_TO_URL, useValue: goTo },
      { provide: SessionStore, useValue: { state: signal(session) } },
    ],
  });
  const version = TestBed.inject(AppVersion);
  version.start();
  return {
    version,
    reload,
    goTo,
    work: TestBed.inject(BusyWork),
    http: TestBed.inject(HttpTestingController),
  };
}

/** The tab comes back to the front. */
function comeBack(): void {
  document.dispatchEvent(new Event('visibilitychange'));
}

function serve(http: HttpTestingController, version: string): void {
  const request = http.expectOne(VERSION_URL);
  expect(request.request.cache).toBe('no-store');
  request.flush({ version });
}

describe('AppVersion (KBC-123)', () => {
  beforeEach(() => {
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => 'visible',
    });
    sessionStorage.clear();
  });

  afterEach(() => {
    TestBed.inject(HttpTestingController).verify();
    vi.useRealTimers();
    document.head
      .querySelectorAll(`meta[name="${APP_VERSION_META}"]`)
      .forEach((tag) => tag.remove());
  });

  it('AC-1: reloads when the tab comes back to another version and nothing is in progress', () => {
    const { version, reload, http } = setup();
    expect(version.current).toBe('v1');
    comeBack();
    serve(http, 'v2');
    expect(reload).toHaveBeenCalledTimes(1);
    expect(version.updateAvailable()).toBe(false);
  });

  it('AC-1: stays when the server has the same version', () => {
    const { version, reload, http } = setup();
    comeBack();
    serve(http, 'v1');
    expect(reload).not.toHaveBeenCalled();
    expect(version.updateAvailable()).toBe(false);
  });

  it('asks again on coming back only after a minute', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const { http } = setup();
    comeBack();
    serve(http, 'v1');
    comeBack();
    http.expectNone(VERSION_URL);
    vi.setSystemTime(Date.now() + 61_000);
    comeBack();
    serve(http, 'v1');
  });

  it('asks every 30 minutes while the tab stays open', () => {
    vi.useFakeTimers();
    const { reload, http } = setup();
    vi.advanceTimersByTime(30 * 60_000);
    serve(http, 'v2');
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('AC-2: with something in progress only offers the update, and "Atualizar" reloads', () => {
    const { version, reload, work, http } = setup();
    work.hold('upload-1');
    comeBack();
    serve(http, 'v2');
    expect(reload).not.toHaveBeenCalled();
    expect(version.updateAvailable()).toBe(true);
    version.update();
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('AC-2: "Agora não" hides the notice for that version, not for a later one', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const { version, reload, work, http } = setup();
    work.hold('upload-1');
    comeBack();
    serve(http, 'v2');
    version.dismiss();
    expect(version.updateAvailable()).toBe(false);
    vi.setSystemTime(Date.now() + 61_000);
    comeBack();
    serve(http, 'v2');
    expect(version.updateAvailable()).toBe(false);
    vi.setSystemTime(Date.now() + 61_000);
    comeBack();
    serve(http, 'v3');
    expect(version.updateAvailable()).toBe(true);
    expect(reload).not.toHaveBeenCalled();
  });

  it('AC-2: a busy signal (text typed) holds until it turns false', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const { version, reload, work, http } = setup();
    const typed = signal(true);
    TestBed.runInInjectionContext(() => work.holdWhile(typed));
    comeBack();
    serve(http, 'v2');
    expect(version.updateAvailable()).toBe(true);
    expect(reload).not.toHaveBeenCalled();
    typed.set(false);
    vi.setSystemTime(Date.now() + 61_000);
    comeBack();
    serve(http, 'v2');
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('AC-3: the login screen reloads even with something marked in progress', () => {
    const { reload, work, http } = setup({ session: { kind: 'signed-out' } });
    work.hold('composer');
    comeBack();
    serve(http, 'v2');
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('AC-3: a public page reloads even with something marked in progress', async () => {
    const { reload, work, http } = setup();
    await TestBed.inject(Router).navigateByUrl('/tutorial');
    work.hold('audio');
    comeBack();
    serve(http, 'v2');
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('AC-4: a reply outside the contract with another version deployed reloads', () => {
    const { reload, http } = setup();
    let code = '';
    TestBed.inject(AuthApi)
      .me()
      .subscribe({ error: (err: unknown) => (code = toUiErrorCode(err)) });
    // The new API's /me no longer has the shape this old app reads.
    http.expectOne('/api/v1/me').flush({ unexpected: true });
    expect(code).toBe('INTERNAL');
    serve(http, 'v2');
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('AC-4: with the same version the error stays as always', () => {
    const { reload, version, http } = setup();
    let code = '';
    TestBed.inject(AuthApi)
      .me()
      .subscribe({ error: (err: unknown) => (code = toUiErrorCode(err)) });
    http.expectOne('/api/v1/me').flush({ unexpected: true });
    serve(http, 'v1');
    expect(reload).not.toHaveBeenCalled();
    expect(version.updateAvailable()).toBe(false);
    expect(code).toBe('INTERNAL');
    expect(errorMessage('INTERNAL')).toBe(
      'Algo deu errado do nosso lado. Tente de novo.',
    );
  });

  it('AC-4: an error with its own code from the API does not ask for the version', () => {
    const { http } = setup();
    TestBed.inject(AuthApi)
      .me()
      .subscribe({ error: (err: unknown) => toUiErrorCode(err) });
    http
      .expectOne('/api/v1/me')
      .flush(
        { error: { code: 'FORBIDDEN', message: 'x' } },
        { status: 403, statusText: 'Forbidden' },
      );
    http.expectNone(VERSION_URL);
  });

  it('AC-5: a lazy route whose chunk is gone loads the asked page from the new app', async () => {
    const { goTo, reload, http } = setup();
    await TestBed.inject(Router)
      .navigateByUrl('/midia/abc?t=10')
      .catch(() => undefined);
    serve(http, 'v2');
    expect(goTo).toHaveBeenCalledWith('/midia/abc?t=10');
    expect(reload).not.toHaveBeenCalled();
  });

  it('AC-6: never reloads twice for the same version within five minutes', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    sessionStorage.setItem(
      RELOAD_MARK_KEY,
      JSON.stringify({ version: 'v2', at: Date.now() - 60_000 }),
    );
    const { version, reload, http } = setup();
    comeBack();
    serve(http, 'v2');
    expect(reload).not.toHaveBeenCalled();
    expect(version.updateAvailable()).toBe(true);
  });

  it('AC-6: reloads again once the window passed, and marks the reload', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    sessionStorage.setItem(
      RELOAD_MARK_KEY,
      JSON.stringify({ version: 'v2', at: Date.now() - 6 * 60_000 }),
    );
    const { reload, http } = setup();
    comeBack();
    serve(http, 'v2');
    expect(reload).toHaveBeenCalledTimes(1);
    const mark = JSON.parse(sessionStorage.getItem(RELOAD_MARK_KEY) ?? '{}');
    expect(mark).toEqual({ version: 'v2', at: Date.now() });
  });

  it('AC-6: blocked storage never stops the check', () => {
    const { reload, http } = setup();
    const refuse = () => {
      throw new DOMException('blocked', 'SecurityError');
    };
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(refuse);
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(refuse);
    comeBack();
    serve(http, 'v2');
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('keeps the page when the version file cannot be read', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { reload, version, http } = setup();
    comeBack();
    http
      .expectOne(VERSION_URL)
      .flush('not found', { status: 404, statusText: 'Not Found' });
    expect(reload).not.toHaveBeenCalled();
    expect(version.updateAvailable()).toBe(false);
    expect(warn).toHaveBeenCalled();
  });

  it('does nothing in development, where the build has no version meta', () => {
    vi.useFakeTimers();
    const { version, http } = setup({ meta: null });
    expect(version.current).toBeNull();
    comeBack();
    vi.advanceTimersByTime(30 * 60_000);
    toUiErrorCode(new Error('outside the contract'));
    version.check('contract');
    http.expectNone(VERSION_URL);
  });
});

describe('isChunkLoadError (KBC-123)', () => {
  it('AC-5: knows a failed chunk import from other errors', () => {
    expect(isChunkLoadError(CHUNK_GONE)).toBe(true);
    expect(
      isChunkLoadError(new TypeError('Importing a module script failed.')),
    ).toBe(true);
    expect(isChunkLoadError(new Error('Cannot match any routes'))).toBe(false);
    expect(
      isChunkLoadError('Failed to fetch dynamically imported module'),
    ).toBe(false);
  });
});
