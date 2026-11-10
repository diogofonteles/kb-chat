import { httpResource } from '@angular/common/http';
import { computed, type Signal } from '@angular/core';
import type { LevelChoice } from '@kb-chat/contracts';
import { mediaLevelsUrl, parseLevelChoices } from '@core/media/media-api.js';

/** What the "Nível" field of a collection offers, and how far it got (KBC-105). */
export interface LevelChoices {
  /** The top-level collection whose scale it is; empty until known. */
  readonly collection: Signal<string>;
  /** Lowest first, up to the person's own; empty without a scale. */
  readonly levels: Signal<readonly LevelChoice[]>;
  readonly loading: Signal<boolean>;
  readonly failed: Signal<boolean>;
}

/**
 * The levels an audio of `topic` may take (T14): asked of the API whenever the collection
 * changes. Call it in an injection context.
 */
export function levelChoicesOf(topic: () => string): LevelChoices {
  const answer = httpResource(
    () => (topic() ? mediaLevelsUrl(topic()) : undefined),
    { parse: parseLevelChoices },
  );
  return {
    collection: computed(() =>
      answer.hasValue() ? answer.value().collection : '',
    ),
    levels: computed(() => (answer.hasValue() ? answer.value().levels : [])),
    loading: computed(() => answer.isLoading()),
    failed: computed(() => answer.status() === 'error'),
  };
}
