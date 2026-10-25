import type { Routes } from '@angular/router';
import { PRIVACY_PATH } from '@core/routing/public-pages.js';

export const routes: Routes = [
  {
    path: '',
    // Every route has a title, or the previous page's would stay in the tab.
    title: $localize`:@@route.homeTitle:Nova Alexandria`,
    loadComponent: () =>
      import('./features/chat/chat-page.js').then((m) => m.ChatPage),
  },
  {
    // Public (KBC-016): the shell renders it with or without a session.
    path: PRIVACY_PATH,
    title: $localize`:@@route.privacyTitle:Privacidade — Nova Alexandria`,
    loadComponent: () =>
      import('./features/privacy/privacy-page.js').then((m) => m.PrivacyPage),
  },
  { path: '**', redirectTo: '' },
];
