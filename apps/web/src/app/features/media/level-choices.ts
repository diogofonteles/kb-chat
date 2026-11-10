import { httpResource, type HttpResourceRef } from '@angular/common/http';
import { computed, linkedSignal, type Signal } from '@angular/core';
import type { LevelChoice, MediaLevelChoices } from '@kb-chat/contracts';
import { mediaLevelsUrl, parseLevelChoices } from '@core/media/media-api.js';

/** What the "Nível" field of a collection offers, and how far it got (KBC-105). */
export interface LevelChoices {
  /** The top-level collection whose scale it is; empty until known. */
  readonly collection: Signal<string>;
  /** Lowest first, up to the person's own; empty without a scale. */
  readonly levels: Signal<readonly LevelChoice[]>;
  readonly loading: Signal<boolean>;
  readonly failed: Signal<boolean>;
  /** Asked again after a failure: the field keeps its place and its focus. */
  readonly retrying: Signal<boolean>;
  /**
   * Whether the field is shown: a scale is known, or the levels could not be had, or they are
   * asked again where a scale (or a failure) was just seen. A collection without levels never
   * flashes a "Carregando níveis…" it will not need (AC-3).
   */
  readonly shown: Signal<boolean>;
  /**
   * The levels could not be had for `root`, which may have a scale: nothing is to be sent
   * until they come (review round 2). One last known to have none goes on as before.
   */
  failedWhereLevelsMayBe(root: string): boolean;
  /** Asks again after a failure; what the person filled in stays. */
  reload(): void;
}

type Settled = 'none' | 'value' | 'error';

/**
 * The levels an audio of `topic` may take (T14): asked of the API whenever the collection
 * changes. Call it in an injection context.
 */
/** What the last request brought and how it ended, kept while the next one is on its way. */
function remembered(answer: HttpResourceRef<MediaLevelChoices | undefined>) {
  const failed = computed(() => answer.status() === 'error');
  const lastAnswer = linkedSignal<
    MediaLevelChoices | null,
    MediaLevelChoices | null
  >({
    source: () => (answer.hasValue() ? answer.value() : null),
    computation: (now, previous) => now ?? previous?.value ?? null,
  });
  const lastSettled = linkedSignal<Settled, Settled>({
    source: () => (answer.hasValue() ? 'value' : failed() ? 'error' : 'none'),
    computation: (now, previous) =>
      now === 'none' ? (previous?.value ?? 'none') : now,
  });
  const scaledBefore = computed(
    () => lastSettled() === 'value' && (lastAnswer()?.levels.length ?? 0) > 0,
  );
  return { failed, lastAnswer, lastSettled, scaledBefore };
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
  const { failed, lastAnswer, lastSettled, scaledBefore } = remembered(answer);
  // Asked again after a failure: the field keeps its place and its focus.
  const retrying = computed(() => loading() && lastSettled() === 'error');
  return {
    collection: computed(() => lastAnswerOf(answer)),
    levels,
    loading,
    failed,
    retrying,
    shown: computed(() => {
      // Read on every change (the template reads `shown`): a linkedSignal only remembers
      // the answers it was asked about while they were there.
      const before = scaledBefore();
      lastAnswer();
      return (
        levels().length > 0 || failed() || retrying() || (loading() && before)
      );
    }),
    failedWhereLevelsMayBe: (root) =>
      failed() && !knownWithoutScale(lastAnswer(), root),
    reload: () => answer.reload(),
  };
}

const lastAnswerOf = (
  answer: HttpResourceRef<MediaLevelChoices | undefined>,
): string => (answer.hasValue() ? answer.value().collection : '');

/** The last answer said `root` has no scale: a failure since then changes nothing there. */
const knownWithoutScale = (
  known: MediaLevelChoices | null,
  root: string,
): boolean => known?.collection === root && known.levels.length === 0;
