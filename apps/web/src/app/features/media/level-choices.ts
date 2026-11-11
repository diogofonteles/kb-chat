import { httpResource, type HttpResourceRef } from '@angular/common/http';
import { computed, effect, linkedSignal, type Signal } from '@angular/core';
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
   * until they come (review round 2). One last known to have none goes on as before. It
   * holds whether or not the field is on the screen (review round 3).
   */
  failedWhereLevelsMayBe(root: string): boolean;
  /** Asks again after a failure; what the person filled in stays. */
  reload(): void;
}

/** How the last request that ended went, and for which collection. */
type Settled =
  | { readonly kind: 'value'; readonly topic: string; readonly scaled: boolean }
  | { readonly kind: 'error'; readonly topic: string };

/** The resource the field reads: the API's answer about one collection's levels. */
type LevelsAnswer = HttpResourceRef<MediaLevelChoices | undefined>;

/**
 * How many levels each top-level collection had when last asked, kept off the screen: a
 * plain map an effect fills, read by the send whether or not the field is shown.
 */
function knownScales(answer: LevelsAnswer): (root: string) => boolean {
  const known = new Map<string, number>();
  effect(() => {
    if (!answer.hasValue()) return;
    const { collection, levels } = answer.value();
    known.set(collection, levels.length);
  });
  return (root) => known.get(root) === 0;
}

/** The last request that ended, kept while the next one is on its way. */
function lastSettled(answer: LevelsAnswer, topic: () => string) {
  return linkedSignal<Settled | null, Settled | null>({
    source: () => {
      if (answer.hasValue())
        return {
          kind: 'value',
          topic: topic(),
          scaled: answer.value().levels.length > 0,
        };
      return answer.status() === 'error'
        ? { kind: 'error', topic: topic() }
        : null;
    },
    computation: (now, previous) => now ?? previous?.value ?? null,
  });
}

/** When the field shows, and whether it is asking again after a failure here. */
function visibilityOf(input: {
  readonly answer: LevelsAnswer;
  readonly topic: () => string;
  readonly rootOf: (slug: string) => string;
  readonly withoutScale: (root: string) => boolean;
}) {
  const { answer, topic, rootOf, withoutScale } = input;
  const settled = lastSettled(answer, topic);
  const loading = () => answer.isLoading();
  // Asked again after a failure of this same collection: the field keeps its place and focus.
  const retrying = computed(() => {
    const last = settled();
    return loading() && last?.kind === 'error' && last.topic === topic();
  });
  const shown = computed(() => {
    const last = settled();
    // A failure where the collection is known to have no levels changes nothing there.
    const failedHere =
      answer.status() === 'error' && !withoutScale(rootOf(topic()));
    const scaledBefore = last?.kind === 'value' && last.scaled;
    const scale = answer.hasValue() && answer.value().levels.length > 0;
    return scale || failedHere || retrying() || (loading() && scaledBefore);
  });
  return { retrying, shown };
}

/**
 * The levels an audio of `topic` may take (T14): asked of the API whenever the collection
 * changes. `rootOf` names the top-level collection whose scale a collection uses. Call it in
 * an injection context.
 */
export function levelChoicesOf(
  topic: () => string,
  rootOf: (slug: string) => string = (slug) => slug,
): LevelChoices {
  const answer = httpResource(
    () => (topic() ? mediaLevelsUrl(topic()) : undefined),
    { parse: parseLevelChoices },
  );
  const failed = computed(() => answer.status() === 'error');
  const withoutScale = knownScales(answer);
  return {
    collection: computed(() =>
      answer.hasValue() ? answer.value().collection : '',
    ),
    levels: computed(() => (answer.hasValue() ? answer.value().levels : [])),
    loading: computed(() => answer.isLoading()),
    failed,
    ...visibilityOf({ answer, topic, rootOf, withoutScale }),
    failedWhereLevelsMayBe: (root) => failed() && !withoutScale(root),
    reload: () => answer.reload(),
  };
}
