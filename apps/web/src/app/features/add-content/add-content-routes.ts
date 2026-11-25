import type { Routes } from '@angular/router';
import { queueEnabled } from '@features/media/media-routes.js';
import { ADD_CONTENT_PATH } from './add-content-path.js';

/** /adicionar (KBC-184), inside the chat page's layout: for who may send content. */
export const ADD_CONTENT_ROUTES: Routes = [
  {
    path: ADD_CONTENT_PATH,
    canMatch: [queueEnabled],
    title: $localize`:@@route.addContentTitle:Adicionar conteúdo — Nova Alexandria`,
    loadComponent: () =>
      import('./add-content-page.js').then((m) => m.AddContentPage),
  },
];
