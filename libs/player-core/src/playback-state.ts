/**
 * The player's state, derived only from what the media element reports (ADR 0025): a call
 * to `play()` never marks the player as playing; the `playing` event does. Every event
 * carries the load it belongs to, and an event of an older load is dropped, so a slow
 * answer for a previous source can never overwrite the current one.
 */

export type PlaybackPhase =
  'empty' | 'loading' | 'paused' | 'playing' | 'ended' | 'error';

/** Why the media could not play, from `MediaError.code`. */
export type PlaybackErrorKind =
  'aborted' | 'network' | 'decode' | 'unsupported';

export interface PlaybackState {
  readonly phase: PlaybackPhase;
  /** The current load; events of other loads are ignored. */
  readonly loadId: number;
  readonly currentMs: number;
  readonly durationMs: number | null;
  /** End of the buffered range that holds the current position. */
  readonly bufferedEndMs: number;
  /** The element is waiting for data. */
  readonly waiting: boolean;
  /** Shown only after the waiting lasted the debounce, never during a person's seek. */
  readonly bufferingVisible: boolean;
  /** A seek the person asked for is in flight. */
  readonly userSeeking: boolean;
  /**
   * The person asked to play and the media has not started yet. Safari on iPhone loads
   * nothing before that gesture, so "loading" alone is not "busy".
   */
  readonly playRequested: boolean;
  readonly error: PlaybackErrorKind | null;
}

export type PlaybackEvent =
  | { readonly type: 'load'; readonly loadId: number }
  | { readonly type: 'unload' }
  | {
      readonly type: 'metadata';
      readonly loadId: number;
      readonly durationMs: number;
    }
  | { readonly type: 'canplay'; readonly loadId: number }
  | { readonly type: 'play-requested'; readonly loadId: number }
  | { readonly type: 'playing'; readonly loadId: number }
  | { readonly type: 'pause'; readonly loadId: number }
  | { readonly type: 'waiting'; readonly loadId: number }
  | { readonly type: 'buffering-elapsed'; readonly loadId: number }
  | {
      readonly type: 'seek-requested';
      readonly loadId: number;
      readonly targetMs: number;
    }
  | { readonly type: 'seeked'; readonly loadId: number }
  | {
      readonly type: 'time';
      readonly loadId: number;
      readonly currentMs: number;
    }
  | {
      readonly type: 'buffered';
      readonly loadId: number;
      readonly endMs: number;
    }
  | { readonly type: 'ended'; readonly loadId: number }
  | {
      readonly type: 'error';
      readonly loadId: number;
      readonly kind: PlaybackErrorKind;
    };

export const INITIAL_PLAYBACK: PlaybackState = {
  phase: 'empty',
  loadId: 0,
  currentMs: 0,
  durationMs: null,
  bufferedEndMs: 0,
  waiting: false,
  bufferingVisible: false,
  userSeeking: false,
  playRequested: false,
  error: null,
};

type EventOf<T extends PlaybackEvent['type']> = Extract<
  PlaybackEvent,
  { type: T }
>;
type Handler<T extends PlaybackEvent['type']> = (
  state: PlaybackState,
  event: EventOf<T>,
) => PlaybackState;

const notWaiting = { waiting: false, bufferingVisible: false } as const;
/** The media stopped (paused, ended, failed): no play request is pending anymore. */
const stopped = { ...notWaiting, playRequested: false } as const;

const HANDLERS: { readonly [T in PlaybackEvent['type']]: Handler<T> } = {
  load: (_state, event) => ({
    ...INITIAL_PLAYBACK,
    phase: 'loading',
    loadId: event.loadId,
  }),
  unload: (state) => ({ ...INITIAL_PLAYBACK, loadId: state.loadId }),
  // Knowing the duration is enough to operate the player (iPhone may send no `canplay`).
  metadata: (state, event) => ({
    ...state,
    durationMs: Math.max(0, event.durationMs),
    phase: state.phase === 'loading' ? 'paused' : state.phase,
  }),
  'play-requested': (state) => ({ ...state, playRequested: true }),
  canplay: (state) => ({
    ...state,
    ...notWaiting,
    phase: state.phase === 'loading' ? 'paused' : state.phase,
  }),
  playing: (state) => ({
    ...state,
    ...stopped,
    phase: 'playing',
    error: null,
  }),
  pause: (state) => ({
    ...state,
    ...stopped,
    phase:
      state.phase === 'ended' || state.phase === 'error'
        ? state.phase
        : 'paused',
  }),
  waiting: (state) => ({ ...state, waiting: true }),
  'buffering-elapsed': (state) => ({
    ...state,
    bufferingVisible: state.waiting && !state.userSeeking,
  }),
  'seek-requested': (state, event) => ({
    ...state,
    userSeeking: true,
    bufferingVisible: false,
    currentMs: clampToDuration(event.targetMs, state.durationMs),
    phase: state.phase === 'ended' ? 'paused' : state.phase,
  }),
  seeked: (state) => ({ ...state, userSeeking: false }),
  time: (state, event) =>
    // While a requested seek is in flight, the element still reports the old position.
    state.userSeeking
      ? state
      : {
          ...state,
          currentMs: clampToDuration(event.currentMs, state.durationMs),
        },
  buffered: (state, event) => ({
    ...state,
    bufferedEndMs: Math.max(0, event.endMs),
  }),
  ended: (state) => ({
    ...state,
    ...stopped,
    phase: 'ended',
    currentMs: state.durationMs ?? state.currentMs,
  }),
  error: (state, event) => ({
    ...state,
    ...stopped,
    phase: 'error',
    error: event.kind,
  }),
};

/** Applies one event; events of an older load leave the state as it is. */
export function reducePlayback(
  state: PlaybackState,
  event: PlaybackEvent,
): PlaybackState {
  if (
    'loadId' in event &&
    event.type !== 'load' &&
    event.loadId !== state.loadId
  )
    return state;
  // The map is keyed by the event's own type, so each handler gets its own event shape.
  const handler = HANDLERS[event.type] as (
    current: PlaybackState,
    received: PlaybackEvent,
  ) => PlaybackState;
  return handler(state, event);
}

/** A position inside the media: never below 0 nor past the duration (when known). */
export function clampToDuration(ms: number, durationMs: number | null): number {
  const floor = Math.max(0, Number.isFinite(ms) ? ms : 0);
  return durationMs === null ? floor : Math.min(floor, durationMs);
}

/** The player can be operated: it has a source and did not fail. */
export const isOperable = (state: PlaybackState): boolean =>
  state.phase === 'paused' ||
  state.phase === 'playing' ||
  state.phase === 'ended';

/**
 * "Tocar" works while the source loads too: on an iPhone nothing loads before that tap,
 * and the tap is what starts it.
 */
export const canAskToPlay = (state: PlaybackState): boolean =>
  isOperable(state) || state.phase === 'loading';

/** Busy for the person: a requested play still loading, or a wait past the debounce. */
export const isBusy = (state: PlaybackState): boolean =>
  state.bufferingVisible || (state.phase === 'loading' && state.playRequested);

/** `MediaError.code` (1–4) to the player's error kinds. */
export function errorKindOf(code: number | undefined): PlaybackErrorKind {
  const kinds: Record<number, PlaybackErrorKind> = {
    1: 'aborted',
    2: 'network',
    3: 'decode',
    4: 'unsupported',
  };
  return kinds[code ?? 2] ?? 'network';
}
