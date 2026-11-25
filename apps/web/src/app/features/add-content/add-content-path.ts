import { computed, inject } from '@angular/core';
import { SessionStore } from '@core/auth/session-store.js';

/** The address of "Adicionar conteúdo" (KBC-184). */
export const ADD_CONTENT_PATH = 'adicionar';

/** The page's query: the collection it starts on. */
export const addContentQuery = (topic: string | null) =>
  topic === null ? {} : { acervo: topic };

/** Who may add content: the same permission as sending audio (KBC-149 BR-1). */
export function canAddContent() {
  const session = inject(SessionStore);
  return computed(
    () =>
      session.me()?.media === true &&
      session.can('media') &&
      session.can('media-upload'),
  );
}
