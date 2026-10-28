import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  INITIAL_PLAYBACK,
  clampToDuration,
  errorKindOf,
  isOperable,
  reducePlayback,
  type PlaybackEvent,
  type PlaybackState,
} from './playback-state.js';

const play = (events: readonly PlaybackEvent[], from = INITIAL_PLAYBACK) =>
  events.reduce(reducePlayback, from);

/** A source loaded as load 1, with a 60 s duration, ready to play. */
const ready = (): PlaybackState =>
  play([
    { type: 'load', loadId: 1 },
    { type: 'metadata', loadId: 1, durationMs: 60_000 },
    { type: 'canplay', loadId: 1 },
  ]);

describe('reducePlayback', () => {
  it('starts empty, loads, and becomes paused when it can play', () => {
    expect(INITIAL_PLAYBACK.phase).toBe('empty');
    const loading = play([{ type: 'load', loadId: 1 }]);
    expect(loading.phase).toBe('loading');
    expect(loading.loadId).toBe(1);
    expect(loading).toMatchObject({ waiting: false, bufferingVisible: false });
    expect(ready()).toMatchObject({ phase: 'paused', durationMs: 60_000 });
  });

  it('is playing only after the element says playing, not when play is asked', () => {
    const state = ready();
    expect(state.phase).toBe('paused');
    expect(play([{ type: 'playing', loadId: 1 }], state).phase).toBe('playing');
  });

  it('goes back to paused when the system pauses it (headphones, a call)', () => {
    const playing = play([{ type: 'playing', loadId: 1 }], ready());
    expect(play([{ type: 'pause', loadId: 1 }], playing).phase).toBe('paused');
  });

  it('drops every event of an older load', () => {
    const second = play([{ type: 'load', loadId: 2 }], ready());
    const after = play(
      [
        { type: 'metadata', loadId: 1, durationMs: 999_000 },
        { type: 'playing', loadId: 1 },
        { type: 'time', loadId: 1, currentMs: 5_000 },
        { type: 'error', loadId: 1, kind: 'network' },
        { type: 'ended', loadId: 1 },
      ],
      second,
    );
    expect(after).toEqual(second);
  });

  it('resets everything on a new load', () => {
    const used = play(
      [
        { type: 'playing', loadId: 1 },
        { type: 'time', loadId: 1, currentMs: 30_000 },
        { type: 'buffered', loadId: 1, endMs: 40_000 },
      ],
      ready(),
    );
    expect(play([{ type: 'load', loadId: 2 }], used)).toEqual({
      ...INITIAL_PLAYBACK,
      phase: 'loading',
      loadId: 2,
    });
  });

  it('unloads to empty but keeps the load number, so late events stay dropped', () => {
    const empty = play([{ type: 'unload' }], ready());
    expect(empty).toMatchObject({
      phase: 'empty',
      loadId: 1,
      durationMs: null,
    });
  });

  describe('buffering', () => {
    it('shows the indicator only when the waiting lasted the debounce', () => {
      const waiting = play(
        [
          { type: 'playing', loadId: 1 },
          { type: 'waiting', loadId: 1 },
        ],
        ready(),
      );
      expect(waiting.bufferingVisible).toBe(false);
      const shown = play([{ type: 'buffering-elapsed', loadId: 1 }], waiting);
      expect(shown.bufferingVisible).toBe(true);
    });

    it('does not show it when the data arrived before the debounce ended', () => {
      const state = play(
        [
          { type: 'waiting', loadId: 1 },
          { type: 'playing', loadId: 1 },
          { type: 'buffering-elapsed', loadId: 1 },
        ],
        ready(),
      );
      expect(state.bufferingVisible).toBe(false);
    });

    it('never shows it during a seek the person asked for', () => {
      const state = play(
        [
          { type: 'seek-requested', loadId: 1, targetMs: 30_000 },
          { type: 'waiting', loadId: 1 },
          { type: 'buffering-elapsed', loadId: 1 },
        ],
        ready(),
      );
      expect(state.bufferingVisible).toBe(false);
    });

    it.each(['canplay', 'playing', 'pause', 'ended', 'error'] as const)(
      'hides it on %s',
      (type) => {
        const shown = play(
          [
            { type: 'waiting', loadId: 1 },
            { type: 'buffering-elapsed', loadId: 1 },
          ],
          ready(),
        );
        const event = (
          type === 'error'
            ? { type, loadId: 1, kind: 'network' }
            : { type, loadId: 1 }
        ) as PlaybackEvent;
        expect(play([event], shown)).toMatchObject({
          waiting: false,
          bufferingVisible: false,
        });
      },
    );
  });

  describe('seeking', () => {
    it('moves to the asked position at once and ignores stale time updates', () => {
      const state = play(
        [
          { type: 'seek-requested', loadId: 1, targetMs: 45_000 },
          { type: 'time', loadId: 1, currentMs: 2_000 },
        ],
        ready(),
      );
      expect(state.currentMs).toBe(45_000);
      expect(state.userSeeking).toBe(true);
      const seeked = play(
        [
          { type: 'seeked', loadId: 1 },
          { type: 'time', loadId: 1, currentMs: 45_250 },
        ],
        state,
      );
      expect(seeked).toMatchObject({ userSeeking: false, currentMs: 45_250 });
    });

    it('keeps a seek inside the media', () => {
      expect(
        play([{ type: 'seek-requested', loadId: 1, targetMs: 99_000 }], ready())
          .currentMs,
      ).toBe(60_000);
      expect(
        play([{ type: 'seek-requested', loadId: 1, targetMs: -1 }], ready())
          .currentMs,
      ).toBe(0);
    });

    it('leaves the ended state when the person seeks back', () => {
      const ended = play([{ type: 'ended', loadId: 1 }], ready());
      expect(ended).toMatchObject({ phase: 'ended', currentMs: 60_000 });
      expect(
        play([{ type: 'seek-requested', loadId: 1, targetMs: 0 }], ended).phase,
      ).toBe('paused');
    });
  });

  it('stays ended or failed when the element pauses after it', () => {
    const ended = play([{ type: 'ended', loadId: 1 }], ready());
    expect(play([{ type: 'pause', loadId: 1 }], ended).phase).toBe('ended');
    const failed = play(
      [{ type: 'error', loadId: 1, kind: 'decode' }],
      ready(),
    );
    expect(play([{ type: 'pause', loadId: 1 }], failed)).toMatchObject({
      phase: 'error',
      error: 'decode',
    });
  });

  it('clears the error when playback recovers', () => {
    const failed = play(
      [{ type: 'error', loadId: 1, kind: 'network' }],
      ready(),
    );
    expect(play([{ type: 'playing', loadId: 1 }], failed)).toMatchObject({
      phase: 'playing',
      error: null,
    });
  });

  it('keeps the canplay phase when it is not loading', () => {
    const playing = play([{ type: 'playing', loadId: 1 }], ready());
    expect(play([{ type: 'canplay', loadId: 1 }], playing).phase).toBe(
      'playing',
    );
  });

  it('ends at the current position when the duration is unknown', () => {
    const state = play([
      { type: 'load', loadId: 1 },
      { type: 'time', loadId: 1, currentMs: 7_000 },
      { type: 'ended', loadId: 1 },
    ]);
    expect(state.currentMs).toBe(7_000);
  });

  it('never stores a negative time, duration or buffer', () => {
    const state = play(
      [
        { type: 'metadata', loadId: 1, durationMs: -1 },
        { type: 'time', loadId: 1, currentMs: -5 },
        { type: 'buffered', loadId: 1, endMs: -3 },
      ],
      ready(),
    );
    expect(state).toMatchObject({
      durationMs: 0,
      currentMs: 0,
      bufferedEndMs: 0,
    });
  });

  it('never leaves a known phase whatever events arrive (property)', () => {
    const phases = ['empty', 'loading', 'paused', 'playing', 'ended', 'error'];
    const anEvent = fc.oneof(
      fc
        .constantFrom<PlaybackEvent['type']>(
          'canplay',
          'playing',
          'pause',
          'waiting',
          'buffering-elapsed',
          'seeked',
          'ended',
        )
        .map((type) => ({ type, loadId: 1 }) as PlaybackEvent),
      fc
        .integer({ min: -10_000, max: 200_000 })
        .map((currentMs): PlaybackEvent => ({
          type: 'time',
          loadId: 1,
          currentMs,
        })),
      fc
        .integer({ min: -10_000, max: 200_000 })
        .map((targetMs): PlaybackEvent => ({
          type: 'seek-requested',
          loadId: 1,
          targetMs,
        })),
    );
    fc.assert(
      fc.property(fc.array(anEvent, { maxLength: 40 }), (events) => {
        const state = play(events, ready());
        expect(phases).toContain(state.phase);
        expect(state.currentMs).toBeGreaterThanOrEqual(0);
        expect(state.currentMs).toBeLessThanOrEqual(60_000);
        if (state.bufferingVisible) expect(state.waiting).toBe(true);
      }),
    );
  });
});

describe('clampToDuration', () => {
  it('keeps a position between 0 and the duration', () => {
    expect(clampToDuration(-1, 10)).toBe(0);
    expect(clampToDuration(11, 10)).toBe(10);
    expect(clampToDuration(5, 10)).toBe(5);
    expect(clampToDuration(5, null)).toBe(5);
    expect(clampToDuration(Number.NaN, 10)).toBe(0);
  });
});

describe('isOperable', () => {
  it('is true only with a playable source', () => {
    expect(isOperable(INITIAL_PLAYBACK)).toBe(false);
    expect(isOperable(play([{ type: 'load', loadId: 1 }]))).toBe(false);
    expect(isOperable(ready())).toBe(true);
    expect(isOperable(play([{ type: 'playing', loadId: 1 }], ready()))).toBe(
      true,
    );
    expect(isOperable(play([{ type: 'ended', loadId: 1 }], ready()))).toBe(
      true,
    );
    expect(
      isOperable(
        play([{ type: 'error', loadId: 1, kind: 'network' }], ready()),
      ),
    ).toBe(false);
  });
});

describe('errorKindOf', () => {
  it.each([
    [1, 'aborted'],
    [2, 'network'],
    [3, 'decode'],
    [4, 'unsupported'],
    [undefined, 'network'],
    [9, 'network'],
  ] as const)('maps MediaError code %s to %s', (code, kind) => {
    expect(errorKindOf(code)).toBe(kind);
  });
});
