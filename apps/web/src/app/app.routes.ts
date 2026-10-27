import type { Routes } from '@angular/router';
import { PRIVACY_PATH, TUTORIAL_PATH } from '@core/routing/public-pages.js';

export const routes: Routes = [
  {
    path: '',
    // Every route has a title, or the previous page's would stay in the tab.
    title: $localize`:@@route.homeTitle:Nova Alexandria`,
    loadComponent: () =>
      import('./features/chat/chat-page.js').then((m) => m.ChatPage),
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
