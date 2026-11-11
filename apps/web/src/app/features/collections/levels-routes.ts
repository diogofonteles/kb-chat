import { inject } from '@angular/core';
import { toObservable } from '@angular/core/rxjs-interop';
import { Router, type CanMatchFn, type Routes } from '@angular/router';
import { SessionStore } from '@core/auth/session-store.js';
import { filter, map, take } from 'rxjs';

/**
 * T24 is the masters' (KBC-103 BR-9); a holder of "Classificar nível de conteúdo" reaches its
 * "Sem nível" section (KBC-107). For anyone else the address is not there.
 */
export const levelsManager: CanMatchFn = () => {
  const session = inject(SessionStore);
  const router = inject(Router);
  return toObservable(session.state).pipe(
    filter((state) => state.kind !== 'loading'),
    take(1),
    map(() =>
      session.me()?.levelsManager === true ||
      session.me()?.features.includes('content-levels') === true
        ? true
        : router.parseUrl('/'),
    ),
  );
};

/** /acervos/:slug/niveis (screens.md T24), inside the chat page's layout. */
export const LEVELS_ROUTES: Routes = [
  {
    path: 'acervos/:slug/niveis',
    canMatch: [levelsManager],
    title: $localize`:@@route.levelsTitle:Níveis de acesso — Nova Alexandria`,
    loadComponent: () => import('./levels-page.js').then((m) => m.LevelsPage),
  },
];
