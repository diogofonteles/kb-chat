import { inject } from '@angular/core';
import { toObservable } from '@angular/core/rxjs-interop';
import { Router, type CanMatchFn, type Routes } from '@angular/router';
import { SessionStore } from '@core/auth/session-store.js';
import { filter, map, take } from 'rxjs';

/**
 * The media pages exist only when the server has the media library on (me.media) and the
 * person was granted "Ouvir mídia" (every feature is granted per person). A link opened
 * directly (/midia/:id) is decided once the session is known, not before.
 */
export const mediaEnabled: CanMatchFn = () => {
  const session = inject(SessionStore);
  const router = inject(Router);
  return toObservable(session.state).pipe(
    filter((state) => state.kind !== 'loading'),
    take(1),
    map(() =>
      session.me()?.media === true && session.can('media')
        ? true
        : router.parseUrl('/'),
    ),
  );
};

/** /midia and /midia/:id (screens.md T14, T15), inside the chat page's layout. */
export const MEDIA_ROUTES: Routes = [
  {
    path: 'midia',
    canMatch: [mediaEnabled],
    title: $localize`:@@route.mediaTitle:Mídia — Nova Alexandria`,
    loadComponent: () =>
      import('./media-list-page.js').then((m) => m.MediaListPage),
  },
  {
    path: 'midia/:id',
    canMatch: [mediaEnabled],
    title: $localize`:@@route.mediaTitle:Mídia — Nova Alexandria`,
    loadComponent: () =>
      import('./media-player-page.js').then((m) => m.MediaPlayerPage),
  },
];
