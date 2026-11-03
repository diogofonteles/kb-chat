import {
  HttpErrorResponse,
  type HttpInterceptorFn,
} from '@angular/common/http';
import { inject } from '@angular/core';
import { catchError, throwError } from 'rxjs';
import { CurrentView, RELOAD_VIEW, VIEW } from './current-view.js';
import { SessionEvents } from './session-events.js';

/** The session's view is no longer the tab's (KBC-060): reload in the current one. */
const isViewChanged = (err: unknown): boolean =>
  err instanceof HttpErrorResponse &&
  err.status === 409 &&
  (err.error as { error?: { code?: unknown } } | null)?.error?.code ===
    'VIEW_CHANGED';

/**
 * CSRF_HEADER and CSRF_HEADER_VALUE of @kb-chat/contracts, copied so the first bundle stays
 * free of the contracts (and zod); a unit test keeps both equal.
 */
export const CSRF = { header: 'x-requested-with', value: 'kb-chat' } as const;

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
/** Their 401 is an answer about signing in, handled by the session store itself. */
const SIGN_IN_URLS = ['/api/v1/me', '/api/v1/auth/'];

/**
 * Every state-changing call carries the CSRF header (ADR 0008), and a 401 anywhere means
 * the session ended: the app goes back to the login screen.
 */
export const authInterceptor: HttpInterceptorFn = (request, next) => {
  const view = inject(CurrentView).id();
  const sent = SAFE_METHODS.has(request.method)
    ? request
    : request.clone({
        setHeaders: {
          [CSRF.header]: CSRF.value,
          // Whose view this tab writes as (KBC-060): a stale tab is refused, not obeyed.
          ...(view !== null && { [VIEW.header]: view }),
        },
      });
  const events = inject(SessionEvents);
  const reloadView = inject(RELOAD_VIEW);
  return next(sent).pipe(
    catchError((err: unknown) => {
      const signInCall = SIGN_IN_URLS.some((url) =>
        request.url.startsWith(url),
      );
      if (err instanceof HttpErrorResponse && err.status === 401 && !signInCall)
        events.expired$.next();
      if (isViewChanged(err)) reloadView();
      return throwError(() => err);
    }),
  );
};
