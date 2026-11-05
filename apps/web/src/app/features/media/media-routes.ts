import { inject } from '@angular/core';
import { toObservable } from '@angular/core/rxjs-interop';
import { Router, type CanMatchFn, type Routes } from '@angular/router';
import { SessionStore } from '@core/auth/session-store.js';
import { filter, map, take } from 'rxjs';
import { hasLibrary } from './library/library-access.js';

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

/**
 * The library (KBC-051 BR-1): "Biblioteca de mídia" on top of "Ouvir mídia". Without it the
 * person keeps the list of T14; /biblioteca goes home.
 */
export const libraryEnabled: CanMatchFn = () => {
  const session = inject(SessionStore);
  const router = inject(Router);
  return toObservable(session.state).pipe(
    filter((state) => state.kind !== 'loading'),
    take(1),
    map(() => (hasLibrary(session) ? true : router.parseUrl('/'))),
  );
};

/** /midia, for who has the library, is /biblioteca (FR-7); else it is not this route. */
export const libraryOnly: CanMatchFn = () => {
  const session = inject(SessionStore);
  return toObservable(session.state).pipe(
    filter((state) => state.kind !== 'loading'),
    take(1),
    map(() => hasLibrary(session)),
  );
};

/**
 * /biblioteca (T16), /midia, /midia/marcadores and /midia/:id (screens.md T14, T15), inside the chat page's
 * layout.
 */
export const MEDIA_ROUTES: Routes = [
  {
    path: 'biblioteca',
    canMatch: [libraryEnabled],
    title: $localize`:@@route.libraryTitle:Biblioteca — Nova Alexandria`,
    loadComponent: () =>
      import('./library/library-page.js').then((m) => m.LibraryPage),
  },
  {
    path: 'midia',
    canMatch: [libraryOnly],
    loadComponent: () =>
      import('./library/media-redirect.js').then((m) => m.MediaRedirect),
  },
  {
    path: 'midia',
    canMatch: [mediaEnabled],
    title: $localize`:@@route.mediaTitle:Mídia — Nova Alexandria`,
    loadComponent: () =>
      import('./media-list-page.js').then((m) => m.MediaListPage),
  },
  {
    path: 'midia/marcadores',
    canMatch: [mediaEnabled],
    title: $localize`:@@route.myBookmarksTitle:Meus marcadores — Nova Alexandria`,
    loadComponent: () =>
      import('./my-bookmarks-page.js').then((m) => m.MyBookmarksPage),
  },
  {
    path: 'midia/:id/preparar',
    canMatch: [mediaEnabled],
    title: $localize`:@@route.tracksTitle:Preparar áudio — Nova Alexandria`,
    loadComponent: () =>
      import('./preparation/preparation-page.js').then(
        (m) => m.PreparationPage,
      ),
  },
  {
    path: 'midia/:id/faixas',
    canMatch: [mediaEnabled],
    title: $localize`:@@route.tracksTitle:Preparar áudio — Nova Alexandria`,
    loadComponent: () =>
      import('./tracks/track-editor-page.js').then((m) => m.TrackEditorPage),
  },
  {
    path: 'midia/:id/limites',
    canMatch: [mediaEnabled],
    title: $localize`:@@route.trackBoundsTitle:Ajustar início e fim — Nova Alexandria`,
    loadComponent: () =>
      import('./track-edit/track-bounds-page.js').then(
        (m) => m.TrackBoundsPage,
      ),
  },
  {
    path: 'midia/:id',
    canMatch: [mediaEnabled],
    title: $localize`:@@route.mediaTitle:Mídia — Nova Alexandria`,
    loadComponent: () =>
      import('./media-player-page.js').then((m) => m.MediaPlayerPage),
  },
];
