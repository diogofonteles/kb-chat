import { isDevMode } from '@angular/core';
import type { Routes } from '@angular/router';
import { PRIVACY_PATH, TUTORIAL_PATH } from '@core/routing/public-pages.js';
import { LEVELS_ROUTES } from './features/collections/levels-routes.js';
import { MEDIA_ROUTES } from './features/media/media-routes.js';
import { SETTINGS_ROUTES } from './features/settings/settings-routes.js';

export const routes: Routes = [
  {
    path: '',
    // Every route has a title, or the previous page's would stay in the tab.
    title: $localize`:@@route.homeTitle:Nova Alexandria`,
    loadComponent: () =>
      import('./features/chat/chat-page.js').then((m) => m.ChatPage),
    // The conversation is the chat page itself; the media pages render inside its layout
    // (the sidebar stays), so the media engine and the conversation survive switching.
    children: [
      { path: '', children: [] },
      ...MEDIA_ROUTES,
      ...LEVELS_ROUTES,
      ...SETTINGS_ROUTES,
      {
        // The v2 component catalog (KBC-124 FR-3): development builds only.
        path: 'catalogo-ui',
        canMatch: [() => isDevMode()],
        title: 'Componentes v2 — Nova Alexandria',
        loadComponent: () =>
          import('./features/ui-catalog/ui-catalog-page.js').then(
            (m) => m.UiCatalogPage,
          ),
      },
    ],
  },
  {
    // Public (KBC-016): the shell renders the policy itself, with or without a session;
    // the route only gives the address and the tab title.
    path: PRIVACY_PATH,
    title: $localize`:@@route.privacyTitle:Privacidade — Nova Alexandria`,
    children: [],
  },
  {
    // Public (KBC-032): rendered by the shell like the policy.
    path: TUTORIAL_PATH,
    title: $localize`:@@route.tutorialTitle:Como usar — Nova Alexandria`,
    children: [],
  },
  { path: '**', redirectTo: '' },
];
