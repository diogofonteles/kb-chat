import { httpResource } from '@angular/common/http';
import { computed, inject, type Signal } from '@angular/core';
import {
  openPreparationsSchema,
  type PreparationStep,
} from '@kb-chat/contracts';
import { SessionStore } from '@core/auth/session-store.js';
import { openPreparationsUrl } from '@core/media/preparation-api.js';

/**
 * Where each open preparation stopped, for the lists (FR-6), by media id. Only for whoever
 * edits recordings, in an injection context. Empty while it loads.
 */
export function injectOpenPreparations(): {
  readonly steps: Signal<ReadonlyMap<string, PreparationStep>>;
  reload(): void;
} {
  const session = inject(SessionStore);
  const resource = httpResource(
    () =>
      session.me() !== null && session.can('media-edit')
        ? openPreparationsUrl
        : undefined,
    { parse: (body) => openPreparationsSchema.parse(body) },
  );
  return {
    steps: computed(
      () =>
        new Map(
          resource.hasValue()
            ? resource.value().items.map(({ mediaId, step }) => [mediaId, step])
            : [],
        ),
    ),
    reload: () => void resource.reload(),
  };
}
