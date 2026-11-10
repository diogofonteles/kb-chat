import { httpResource } from '@angular/common/http';
import { computed, linkedSignal, type Signal } from '@angular/core';
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
  /**
   * Whether the field is shown: a scale is known, or the levels could not be had, or they are
   * asked again where a scale was just seen. A collection without levels never flashes a
   * "Carregando níveis…" it will not need (AC-3).
   */
  readonly shown: Signal<boolean>;
  /** Asks again after a failure; what the person filled in stays. */
  reload(): void;
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
  const levels = computed(() =>
    answer.hasValue() ? answer.value().levels : [],
  );
  const loading = computed(() => answer.isLoading());
  const failed = computed(() => answer.status() === 'error');
  /** The last answer had a scale: kept while the next one is on its way. */
  const scaledBefore = linkedSignal<boolean, boolean>({
    source: () =>
      answer.hasValue() ? answer.value().levels.length > 0 : false,
    computation: (scaled, previous) =>
      answer.hasValue() ? scaled : (previous?.value ?? false),
  });
  return {
    collection: computed(() =>
      answer.hasValue() ? answer.value().collection : '',
    ),
    levels,
    loading,
    failed,
    shown: computed(
      () => levels().length > 0 || failed() || (loading() && scaledBefore()),
    ),
    reload: () => answer.reload(),
  };
}
