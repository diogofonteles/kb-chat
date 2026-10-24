import type { Routes } from '@angular/router';

export const routes: Routes = [
  {
    path: '',
    loadComponent: () =>
      import('./features/chat/chat-page.js').then((m) => m.ChatPage),
  },
  { path: '**', redirectTo: '' },
];
