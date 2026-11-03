import { computed, inject, type Signal } from '@angular/core';
import type { Authorship } from '@kb-chat/contracts';
import { authorshipLabelsOf } from '@core/i18n/facet-labels.js';
import { ChatStore } from '@features/chat/chat-store.js';

/**
 * The authorship labels of the open collection (KBC-049): its main author's name for the
 * `mestre-laercio` group. Outside a page with a collection, the labels of before.
 * Call in an injection context.
 */
export function injectAuthorshipLabels(): Signal<Record<Authorship, string>> {
  const chat = inject(ChatStore, { optional: true });
  return computed(() =>
    authorshipLabelsOf(chat?.topic()?.mainAuthor?.name ?? null),
  );
}
