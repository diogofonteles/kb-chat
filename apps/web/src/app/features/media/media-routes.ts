import { inject } from '@angular/core';
import { Router, type CanMatchFn, type Routes } from '@angular/router';
import { SessionStore } from '@core/auth/session-store.js';

/**
 * The media pages exist only when the server has the media library on (me.media) and the
 * person was granted "Ouvir mídia" (every feature is granted per person).
 */
export const mediaEnabled: CanMatchFn = () => {
  const session = inject(SessionStore);
  const allowed = session.me()?.media === true && session.can('media');
  return allowed || inject(Router).parseUrl('/');
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
