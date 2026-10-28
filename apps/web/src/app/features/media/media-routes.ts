import { inject } from '@angular/core';
import { Router, type CanMatchFn, type Routes } from '@angular/router';
import { SessionStore } from '@core/auth/session-store.js';

/** The media pages exist only when the server has the media library on (me.media). */
export const mediaEnabled: CanMatchFn = () =>
  inject(SessionStore).me()?.media === true || inject(Router).parseUrl('/');

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
