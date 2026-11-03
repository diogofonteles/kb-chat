import { HttpErrorResponse } from '@angular/common/http';
import { DOCUMENT } from '@angular/common';
import {
  Injectable,
  InjectionToken,
  computed,
  inject,
  signal,
} from '@angular/core';
import {
  apiErrorSchema,
  notInvitedDetailsSchema,
  type Feature,
  type Me,
  type NotInvitedDetails,
} from '@kb-chat/contracts';
import { toUiErrorCode, type UiErrorCode } from '@core/api/api-error.js';
import { catchError, map, of, tap, type Observable } from 'rxjs';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { CurrentView, VIEW, announceViewChange } from './current-view.js';
import { AuthApi } from './auth-api.js';
import { SessionEvents } from './session-events.js';

/** Where the app is: deciding, the login screen (with why), or signed in. */
export type SessionState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'signed-out' }
  | {
      readonly kind: 'not-invited';
      /** The ticket for "Solicitar acesso" and where the request stands (KBC-014). */
      readonly details: NotInvitedDetails | null;
    }
  | { readonly kind: 'failed'; readonly code: UiErrorCode }
  | { readonly kind: 'signed-in'; readonly me: Me };

/**
 * Starts the page over. After a session ends every per-person store (settings, history,
 * spend) must go with it, so nothing of one person shows to the next (BR-6).
 */
export const RELOAD_PAGE = new InjectionToken<() => void>('RELOAD_PAGE', {
  providedIn: 'root',
  factory: () => {
    const view = inject(DOCUMENT).defaultView;
    return () => view?.location.reload();
  },
});

const isUnauthenticated = (err: unknown): boolean =>
  err instanceof HttpErrorResponse && err.status === 401;

/** The ticket and request state that come with a not-invited answer, if any. */
function notInvitedDetailsOf(err: unknown): NotInvitedDetails | null {
  if (!(err instanceof HttpErrorResponse)) return null;
  const envelope = apiErrorSchema.safeParse(err.error);
  const details = notInvitedDetailsSchema.safeParse(
    envelope.success ? envelope.data.error.details : undefined,
  );
  return details.success ? details.data : null;
}

/**
 * Who is signed in (KBC-010 FR-2): the shell shows the login screen until /me answers, and
 * builds the navigation from it. Before /me loads (only in unit tests of single components)
 * every check allows, since the API enforces the permissions anyway.
 */
@Injectable({ providedIn: 'root' })
export class SessionStore {
  private readonly api = inject(AuthApi);
  private readonly reloadPage = inject(RELOAD_PAGE);
  private readonly view = inject(CurrentView);
  private readonly current = signal<SessionState>({ kind: 'loading' });

  readonly state = this.current.asReadonly();
  readonly me = computed(() => {
    const state = this.current();
    return state.kind === 'signed-in' ? state.me : null;
  });
  readonly isMaster = computed(() => this.me()?.role === 'master');

  constructor() {
    inject(SessionEvents)
      .expired$.pipe(takeUntilDestroyed())
      .subscribe(() => this.expired());
  }

  /** Asks the API who is signed in (the session cookie is httpOnly). */
  start(): void {
    this.api
      .me()
      .pipe(catchError((err: unknown) => of(this.failure(err))))
      .subscribe((result) => this.settle(result));
  }

  can(feature: Feature): boolean {
    const me = this.me();
    return me === null || me.features.includes(feature);
  }

  /** Google handed over an ID token: trade it for a session. */
  signIn(credential: string): Observable<Me | SessionState> {
    return this.api.signIn(credential).pipe(
      catchError((err: unknown) => of(this.failure(err))),
      tap((result) => this.settle(result)),
    );
  }

  /** A one-time code (KBC-014): signed in, or the reason it was refused, for the form. */
  verifyCode(identifier: string, code: string): Observable<UiErrorCode | null> {
    return this.api.verifyCode(identifier, code).pipe(
      map((me) => {
        this.settle(me);
        return null;
      }),
      catchError((err: unknown) => of(toUiErrorCode(err))),
    );
  }

  signOut(): Observable<void> {
    return this.api.signOut().pipe(
      catchError(() => of(undefined)),
      // While acting, "Sair" brings the master back: the other tabs change view too.
      tap(() => announceViewChange()),
      tap(() => this.end()),
    );
  }

  /** Any call answered 401: the session ended (revoked, expired), back to the login screen. */
  expired(): void {
    if (this.current().kind === 'signed-in') this.end();
  }

  private end(): void {
    this.current.set({ kind: 'signed-out' });
    this.reloadPage();
  }

  /** "Sair" on the not-invited screen: try another account. */
  reset(): void {
    this.current.set({ kind: 'signed-out' });
  }

  private settle(result: Me | SessionState): void {
    const state: SessionState =
      'kind' in result ? result : { kind: 'signed-in', me: result };
    this.current.set(state);
    // Whose view this tab writes as (KBC-060 BR-3).
    this.view.set(
      state.kind === 'signed-in'
        ? (state.me.actingAs?.person.id ?? VIEW.own)
        : null,
    );
  }

  private failure(err: unknown): SessionState {
    if (isUnauthenticated(err)) return { kind: 'signed-out' };
    const code = toUiErrorCode(err);
    return code === 'NOT_INVITED'
      ? { kind: 'not-invited', details: notInvitedDetailsOf(err) }
      : { kind: 'failed', code };
  }
}
