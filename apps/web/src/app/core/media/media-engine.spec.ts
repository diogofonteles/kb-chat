import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BusyWork } from '@core/app-version/busy-work.js';
import {
  fakeMediaElement,
  type FakeMedia,
} from '../../testing/fake-media-element.js';
import {
  BUFFERING_DEBOUNCE_MS,
  MEDIA_ELEMENT_FACTORY,
  MediaEngine,
  mediaTagOf,
  type PlayableSource,
} from './media-engine.js';

const LECTURE: PlayableSource = {
  id: '11111111-1111-4111-8111-111111111111',
  title: 'Palestra de 1998',
  src: '/api/v1/media/11111111-1111-4111-8111-111111111111/stream',
};
const OTHER: PlayableSource = {
  ...LECTURE,
  id: 'other',
  src: '/api/v1/media/other/stream',
};

/**
 * The engine's contract (ADR 0025, KBC-034 AC-14): it must behave the same over an
 * `<audio>` and a `<video>`, so video (KBC-035) only adds a view.
 */
describe.each(['audio', 'video'] as const)('MediaEngine over <%s>', (tag) => {
  let media: FakeMedia;
  let engine: MediaEngine;

  /** Loaded and ready: 60 s, paused at 0. */
  function ready(source = LECTURE, startAtMs = 0) {
    engine.load(source, startAtMs);
    media.setDuration(60);
    media.emit('loadedmetadata');
    media.emit('canplay');
  }

  beforeEach(() => {
    media = fakeMediaElement(tag);
    TestBed.configureTestingModule({
      providers: [
        { provide: MEDIA_ELEMENT_FACTORY, useValue: () => media.element },
      ],
    });
    engine = TestBed.inject(MediaEngine);
  });
  afterEach(() => vi.useRealTimers());

  it('creates its element with the right tag', () => {
    ready();
    expect(media.element.tagName).toBe(tag.toUpperCase());
  });

  it('loads paused, with metadata only, and never plays by itself', () => {
    ready();
    expect(media.element.getAttribute('src')).toBe(LECTURE.src);
    expect(media.element.preload).toBe('metadata');
    expect(media.calls).toEqual([`load:${LECTURE.src}`]);
    expect(engine.playback()).toMatchObject({
      phase: 'paused',
      durationMs: 60_000,
    });
    expect(engine.source()).toEqual(LECTURE);
  });

  it('is playing only when the element says so (AC-10)', async () => {
    ready();
    engine.play();
    expect(media.calls).toContain('play');
    expect(engine.playing()).toBe(false);
    media.emit('playing');
    expect(engine.playing()).toBe(true);
  });

  it('is in progress for a new version only while it plays (KBC-123 AC-2)', () => {
    const work = TestBed.inject(BusyWork);
    ready();
    expect(work.busy()).toBe(false);
    media.emit('playing');
    expect(work.busy()).toBe(true);
    media.emit('pause');
    expect(work.busy()).toBe(false);
  });

  it('follows a pause the system makes (headphones, a call)', () => {
    ready();
    media.emit('playing');
    media.emit('pause');
    expect(engine.playback().phase).toBe('paused');
  });

  it('toggles between play and pause', () => {
    ready();
    engine.toggle();
    expect(media.calls.at(-1)).toBe('play');
    media.emit('playing');
    engine.toggle();
    expect(media.calls.at(-1)).toBe('pause');
  });

  it('takes a new title without touching the sound, and only for its own media', () => {
    ready();
    const calls = [...media.calls];
    engine.retitle(OTHER.id, 'Outra');
    expect(engine.source()?.title).toBe(LECTURE.title);
    engine.retitle(LECTURE.id, 'Novo título');
    expect(engine.source()).toEqual({ ...LECTURE, title: 'Novo título' });
    expect(media.calls).toEqual(calls);
  });

  it('does not count opening at a saved position as a skip of the person', () => {
    engine.load(LECTURE, 30_000);
    media.setDuration(60);
    media.emit('loadedmetadata');
    media.emit('seeked');
    expect(engine.seeksLanded()).toBe(0);
    engine.skip(5_000);
    media.emit('seeked');
    expect(engine.seeksLanded()).toBe(1);
  });

  it('does not count a skipped silence as a skip of the person (KBC-044)', () => {
    ready();
    engine.skipSilence(7_550);
    expect(media.calls.at(-1)).toBe('seek:7.55');
    media.emit('seeked');
    expect(engine.seeksLanded()).toBe(0);
    engine.seek(20_000);
    media.emit('seeked');
    expect(engine.seeksLanded()).toBe(1);
  });

  it('counts a seek when it is asked, and not the ones the app makes (KBC-045)', () => {
    engine.load(LECTURE, 30_000);
    media.setDuration(60);
    media.emit('loadedmetadata');
    engine.skipSilence(40_000);
    expect(engine.seeksAsked()).toBe(0);
    engine.skip(5_000);
    expect(engine.seeksAsked()).toBe(1);
    expect(engine.seeksLanded()).toBe(0);
  });

  it('reads the position live from the element, and skips nothing without a source', () => {
    expect(engine.positionNowMs()).toBe(0);
    engine.skipSilence(1_000);
    expect(media.calls).not.toContain('seek:1');
    ready();
    media.setCurrentTime(12.345);
    expect(engine.positionNowMs()).toBeCloseTo(12_345);
    expect(engine.playback().currentMs).toBe(0);
  });

  it('starts at the asked second once the duration is known', () => {
    ready(LECTURE, 45_000);
    expect(media.calls).toContain('seek:45');
    expect(engine.playback().currentMs).toBe(45_000);
  });

  it('skips forward 30 s and back 15 s without passing the edges (AC-10)', () => {
    ready();
    engine.skip(30_000);
    expect(engine.playback().currentMs).toBe(30_000);
    engine.skip(45_000);
    expect(engine.playback().currentMs).toBe(60_000);
    expect(media.calls.at(-1)).toBe('seek:60');
    engine.seek(5_000);
    engine.skip(-15_000);
    expect(media.calls.at(-1)).toBe('seek:0');
  });

  it('follows the time and the buffered range around it', () => {
    ready();
    media.emit('seeked');
    media.setCurrentTime(12.5);
    media.setBuffered([
      [0, 5],
      [10, 40],
    ]);
    media.emit('timeupdate');
    expect(engine.playback()).toMatchObject({
      currentMs: 12_500,
      bufferedEndMs: 40_000,
    });
    media.setCurrentTime(50);
    media.emit('progress');
    expect(engine.playback().bufferedEndMs).toBe(40_000);
  });

  it('shows buffering only after the debounce, never during a seek', () => {
    vi.useFakeTimers();
    ready();
    media.emit('playing');
    media.emit('waiting');
    vi.advanceTimersByTime(BUFFERING_DEBOUNCE_MS - 1);
    expect(engine.playback().bufferingVisible).toBe(false);
    vi.advanceTimersByTime(1);
    expect(engine.playback().bufferingVisible).toBe(true);
    media.emit('playing');
    engine.seek(30_000);
    media.emit('waiting');
    vi.advanceTimersByTime(BUFFERING_DEBOUNCE_MS);
    expect(engine.playback().bufferingVisible).toBe(false);
  });

  describe('stop at a time (KBC-160 FR-1)', () => {
    /** Ready, playing from 68 s, with a stop armed at 95 s (the passage 1:10–1:35). */
    function playingToStop(onStop = vi.fn()) {
      vi.useFakeTimers();
      ready();
      media.setDuration(180);
      media.emit('durationchange');
      engine.seek(68_000);
      media.emit('seeked');
      engine.play();
      media.emit('playing');
      engine.stopAt({ fromMs: 68_000, toMs: 95_000, onStop });
      return onStop;
    }

    it('pauses by itself at the stop, between time updates, and says so first (AC-1, BR-6)', () => {
      const onStop = playingToStop();
      expect(engine.stopAtMs()).toBe(95_000);
      media.setCurrentTime(94.99);
      vi.advanceTimersByTime(26_985);
      expect(media.calls.at(-1)).toBe('pause');
      expect(onStop).toHaveBeenCalledTimes(1);
      expect(engine.stopAtMs()).toBeNull();
      media.emit('pause');
      expect(engine.playback().phase).toBe('paused');
    });

    it('waits on the clock that is: a timer early only checks again', () => {
      const onStop = playingToStop();
      vi.advanceTimersByTime(26_985);
      expect(onStop).not.toHaveBeenCalled();
      expect(media.calls).not.toContain('pause');
      media.setCurrentTime(95);
      media.emit('timeupdate');
      expect(onStop).toHaveBeenCalledTimes(1);
      expect(media.calls.at(-1)).toBe('pause');
    });

    it('goes back to the stop when it is found past it (a timer held back)', () => {
      playingToStop();
      media.setCurrentTime(96);
      media.emit('timeupdate');
      expect(media.calls.slice(-2)).toEqual(['pause', 'seek:95']);
    });

    it('waits half as long at twice the speed', () => {
      const onStop = playingToStop();
      engine.setSpeed(2);
      media.setCurrentTime(94.99);
      vi.advanceTimersByTime(13_485);
      expect(onStop).toHaveBeenCalledTimes(1);
    });

    it('is disarmed by a seek outside its span, and the track plays on (AC-2)', () => {
      const onStop = playingToStop();
      engine.seek(120_000);
      media.emit('seeked');
      expect(engine.stopAtMs()).toBeNull();
      media.setCurrentTime(121);
      media.emit('timeupdate');
      vi.advanceTimersByTime(60_000);
      expect(onStop).not.toHaveBeenCalled();
      expect(media.calls.at(-1)).not.toBe('pause');
    });

    it('is disarmed by a seek the element made by itself out of its span', () => {
      const onStop = playingToStop();
      media.setCurrentTime(5.2);
      media.emit('seeked');
      expect(engine.stopAtMs()).toBeNull();
      media.setCurrentTime(95);
      media.emit('timeupdate');
      expect(onStop).not.toHaveBeenCalled();
    });

    it('is disarmed by a seek before its span', () => {
      playingToStop();
      engine.seek(10_000);
      expect(engine.stopAtMs()).toBeNull();
    });

    it('stays armed through a seek inside its span (AC-3)', () => {
      const onStop = playingToStop();
      engine.seek(80_000);
      media.setSeeking(true);
      media.setCurrentTime(80);
      media.emit('waiting');
      media.setSeeking(false);
      media.emit('seeked');
      expect(engine.stopAtMs()).toBe(95_000);
      media.setCurrentTime(95);
      media.emit('timeupdate');
      expect(onStop).toHaveBeenCalledTimes(1);
      // A lone `waiting` after the seek is no stall (KBC-162): no network error.
      vi.advanceTimersByTime(12_000);
      expect(engine.playback().error).toBeNull();
    });

    it('waits through a stall in its span without stopping, and stops at the end once it plays on (KBC-162)', () => {
      const onStop = playingToStop();
      media.setCurrentTime(90);
      media.emit('timeupdate');
      // The network holds the element at 1:30, not paused: its timer only checks again.
      media.emit('waiting');
      vi.advanceTimersByTime(8_000);
      media.emit('timeupdate');
      expect(onStop).not.toHaveBeenCalled();
      expect(media.calls).not.toContain('pause');
      expect(engine.stopAtMs()).toBe(95_000);
      expect(engine.playback()).toMatchObject({ waiting: true, error: null });
      // Data comes back: the clock moves on with no `playing` event and the wait is over.
      media.setReadyState(HTMLMediaElement.HAVE_FUTURE_DATA);
      media.setCurrentTime(90.25);
      media.emit('timeupdate');
      expect(engine.playback()).toMatchObject({
        phase: 'playing',
        waiting: false,
      });
      media.setCurrentTime(94.99);
      vi.advanceTimersByTime(4_735);
      expect(onStop).toHaveBeenCalledTimes(1);
      expect(media.calls.at(-1)).toBe('pause');
      media.emit('pause');
      // The stall timer is gone with the wait: no network error after the stop.
      vi.advanceTimersByTime(12_000);
      expect(engine.playback()).toMatchObject({ phase: 'paused', error: null });
    });

    it('is disarmed by a pause, another load and the end of the media', () => {
      const onStop = playingToStop();
      engine.pause();
      media.emit('pause');
      expect(engine.stopAtMs()).toBeNull();
      engine.stopAt({ fromMs: 0, toMs: 95_000 });
      engine.load(OTHER);
      expect(engine.stopAtMs()).toBeNull();
      ready();
      engine.play();
      media.emit('playing');
      engine.stopAt({ fromMs: 0, toMs: 95_000 });
      media.emit('ended');
      expect(engine.stopAtMs()).toBeNull();
      media.setCurrentTime(95);
      media.emit('timeupdate');
      expect(onStop).not.toHaveBeenCalled();
    });

    it('is disarmed by null, and arms nothing with no media', () => {
      playingToStop();
      engine.stopAt(null);
      expect(engine.stopAtMs()).toBeNull();
      engine.unload();
      engine.stopAt({ fromMs: 0, toMs: 1_000 });
      expect(engine.stopAtMs()).toBeNull();
    });

    it('does not count its own way back to the stop as a seek of the person', () => {
      playingToStop();
      const asked = engine.seeksAsked();
      media.setCurrentTime(97);
      media.emit('timeupdate');
      media.emit('seeked');
      expect(engine.seeksAsked()).toBe(asked);
    });
  });

  it('stops and reports a network error when the wait never ends (AC-12)', () => {
    vi.useFakeTimers();
    ready();
    media.emit('playing');
    media.emit('waiting');
    vi.advanceTimersByTime(11_999);
    expect(engine.playback().phase).toBe('playing');
    vi.advanceTimersByTime(1);
    expect(engine.playback()).toMatchObject({
      phase: 'error',
      error: 'network',
    });
    expect(media.calls.at(-1)).toBe('pause');
  });

  it('reports a network error when a requested play never becomes playable (AC-12)', () => {
    vi.useFakeTimers();
    engine.load(LECTURE);
    vi.advanceTimersByTime(60_000);
    // Nothing asked yet: an iPhone loads nothing before the tap, which is not an error.
    expect(engine.playback().phase).toBe('loading');
    engine.play();
    expect(engine.busy()).toBe(true);
    vi.advanceTimersByTime(12_000);
    expect(engine.playback()).toMatchObject({
      phase: 'error',
      error: 'network',
    });
  });

  it('lets "Tocar" work while loading, and the tap starts playing (iPhone)', () => {
    engine.load(LECTURE);
    expect(engine.canPlay()).toBe(true);
    expect(engine.operable()).toBe(false);
    engine.play();
    expect(media.calls.at(-1)).toBe('play');
    media.emit('playing');
    expect(engine.playback().phase).toBe('playing');
    expect(engine.busy()).toBe(false);
  });

  it('keeps a source that became playable in time', () => {
    vi.useFakeTimers();
    ready();
    vi.advanceTimersByTime(60_000);
    expect(engine.playback().phase).toBe('paused');
  });

  it('forgets the stall timer when the data comes back', () => {
    vi.useFakeTimers();
    ready();
    media.emit('playing');
    media.emit('waiting');
    vi.advanceTimersByTime(5_000);
    media.emit('playing');
    vi.advanceTimersByTime(20_000);
    expect(engine.playback().phase).toBe('playing');
  });

  it('drops a buffering timer of an older load', () => {
    vi.useFakeTimers();
    ready();
    media.emit('waiting');
    engine.load(OTHER);
    vi.advanceTimersByTime(BUFFERING_DEBOUNCE_MS);
    expect(engine.playback()).toMatchObject({
      phase: 'loading',
      bufferingVisible: false,
    });
  });

  it('ends and plays again from the start', () => {
    ready();
    media.emit('playing');
    media.emit('ended');
    expect(engine.playback().phase).toBe('ended');
    engine.play();
    expect(media.calls.slice(-2)).toEqual(['seek:0', 'play']);
  });

  it('ignores a pause the browser queued before "Ouvir de novo" played again (WebKit on Linux)', () => {
    ready();
    engine.play();
    media.emit('playing');
    media.setPaused(true);
    media.emit('ended');
    engine.play();
    media.emit('playing');
    // The end's own pause arrives late, while the element already plays again.
    media.emit('pause');
    expect(engine.playing()).toBe(true);
  });

  it('is playing once the clock moves on an unpaused element, even with no playing event', () => {
    ready();
    engine.play();
    // A tick that does not move (the load's own) is not playback.
    media.emit('timeupdate');
    expect(engine.playing()).toBe(false);
    media.setCurrentTime(0.25);
    media.emit('timeupdate');
    expect(engine.playing()).toBe(true);
  });

  it('is no longer waiting once the clock moves after a skip, though no playing event comes (WebKit on Linux)', () => {
    vi.useFakeTimers();
    ready();
    engine.play();
    media.emit('playing');
    engine.seek(30_000);
    media.emit('seeking');
    // Linux WebKit: the wait comes after the seek lands, and no canplay/playing follows it,
    // though the element plays on (its readyState stays at HAVE_CURRENT_DATA).
    media.emit('seeked');
    media.emit('waiting');
    for (let second = 1; second <= 20; second++) {
      vi.advanceTimersByTime(1_000);
      media.setCurrentTime(30 + second);
      media.emit('timeupdate');
    }
    expect(engine.playback()).toMatchObject({
      phase: 'playing',
      error: null,
      waiting: false,
      bufferingVisible: false,
    });
    expect(media.calls).not.toContain('pause');
  });

  it('still reports the network when the clock stops after the wait (AC-12)', () => {
    vi.useFakeTimers();
    ready();
    engine.play();
    media.emit('playing');
    media.setCurrentTime(10);
    media.emit('timeupdate');
    media.emit('waiting');
    // A tick that does not move is no playback: the wait goes on to the error.
    media.emit('timeupdate');
    vi.advanceTimersByTime(12_000);
    expect(engine.playback()).toMatchObject({
      phase: 'error',
      error: 'network',
    });
  });

  it('keeps the network error of a backward skip that never lands (AC-12)', () => {
    vi.useFakeTimers();
    ready();
    engine.play();
    media.emit('playing');
    media.setCurrentTime(40);
    media.emit('timeupdate');
    engine.seek(10_000);
    media.setSeeking(true);
    media.emit('seeking');
    media.emit('waiting');
    // The network is gone: the element still tells the old position, past the target.
    media.setCurrentTime(40);
    media.emit('timeupdate');
    vi.advanceTimersByTime(12_000);
    expect(engine.playback()).toMatchObject({
      phase: 'error',
      error: 'network',
    });
  });

  it('keeps the network error when one tick moves after the wait and the clock stops (AC-12)', () => {
    vi.useFakeTimers();
    ready();
    engine.play();
    media.emit('playing');
    media.setCurrentTime(10);
    media.emit('timeupdate');
    media.emit('waiting');
    // What was decoded plays on for a moment, then nothing more comes.
    media.setCurrentTime(10.05);
    media.emit('timeupdate');
    vi.advanceTimersByTime(6_000);
    media.emit('timeupdate');
    vi.advanceTimersByTime(6_000);
    expect(engine.playback()).toMatchObject({
      phase: 'error',
      error: 'network',
    });
  });

  it('ends the wait at one tick once the element has data ahead again', () => {
    vi.useFakeTimers();
    ready();
    engine.play();
    media.emit('playing');
    media.setCurrentTime(10);
    media.emit('timeupdate');
    media.emit('waiting');
    media.setReadyState(HTMLMediaElement.HAVE_FUTURE_DATA);
    media.setCurrentTime(10.05);
    media.emit('timeupdate');
    vi.advanceTimersByTime(12_000);
    expect(engine.playback()).toMatchObject({
      phase: 'playing',
      waiting: false,
    });
  });

  it('does not take a requested seek for playback', () => {
    ready();
    engine.play();
    engine.seek(30_000);
    media.emit('timeupdate');
    expect(engine.playing()).toBe(false);
  });

  it('does not call it playing when the clock moves on a paused element (a seek)', () => {
    ready();
    media.setCurrentTime(10);
    media.emit('timeupdate');
    media.setCurrentTime(20);
    media.emit('timeupdate');
    expect(engine.playing()).toBe(false);
  });

  it('reports a network error and retries from the same second (AC-12)', () => {
    ready();
    media.emit('seeked');
    media.setCurrentTime(23);
    media.emit('timeupdate');
    media.setError(2);
    media.emit('error');
    expect(engine.playback()).toMatchObject({
      phase: 'error',
      error: 'network',
    });
    media.setError(null);
    engine.retry();
    expect(media.calls.at(-2)).toBe(`load:${LECTURE.src}`);
    media.setDuration(60);
    media.emit('loadedmetadata');
    expect(media.calls).toContain('seek:23');
  });

  it('reads Safari\'s "not supported" after a playable start as a network failure', () => {
    ready();
    media.setError(4);
    media.emit('error');
    expect(engine.playback().error).toBe('network');
  });

  it('reads "not supported" as the network even before any play (our files are AAC)', () => {
    engine.load(LECTURE);
    media.setError(4);
    media.emit('error');
    expect(engine.playback().error).toBe('network');
  });

  it('ends a paused seek to the very end, though the browser fires no ended', () => {
    ready();
    engine.seek(60_000);
    media.emit('seeked');
    expect(engine.playback().phase).toBe('ended');
  });

  it('does not end a playing seek near the end: the browser ends it itself', () => {
    ready();
    media.emit('playing');
    media.setPaused(false);
    engine.seek(60_000);
    media.emit('seeked');
    expect(engine.playback().phase).toBe('playing');
    media.emit('ended');
    expect(engine.playback().phase).toBe('ended');
  });

  it('keeps playing state on a paused seek away from the end', () => {
    ready();
    engine.seek(30_000);
    media.emit('seeked');
    expect(engine.playback().phase).toBe('paused');
  });

  it('treats a refused play without a gesture as normal, and a real refusal as an error', async () => {
    ready();
    media.playAnswer = 'not-allowed';
    engine.play();
    await Promise.resolve();
    await Promise.resolve();
    expect(engine.playback().phase).toBe('paused');
    media.playAnswer = 'fail';
    engine.play();
    await vi.waitFor(() => expect(engine.playback().phase).toBe('error'));
  });

  it('ignores a refusal that belongs to a load already replaced', async () => {
    ready();
    media.playAnswer = 'fail';
    engine.play();
    engine.load(OTHER);
    await Promise.resolve();
    await Promise.resolve();
    expect(engine.playback().phase).toBe('loading');
  });

  it('keeps loading when the duration is not known yet', () => {
    engine.load(LECTURE);
    media.emit('durationchange');
    expect(engine.playback()).toMatchObject({
      phase: 'loading',
      durationMs: null,
    });
  });

  it('unloads without an error event or a request to the page', () => {
    ready();
    engine.unload();
    expect(media.element.hasAttribute('src')).toBe(false);
    expect(media.calls.slice(-2)).toEqual(['pause', 'load:']);
    media.emit('error');
    expect(engine.playback()).toMatchObject({ phase: 'empty', error: null });
    expect(engine.source()).toBeNull();
  });

  it('does nothing before a source is loaded', () => {
    engine.play();
    engine.seek(1_000);
    engine.retry();
    expect(media.calls).toEqual([]);
    expect(engine.playback().phase).toBe('empty');
  });

  it('applies the speed now and to every source it loads, keeping the voice (FR-5)', () => {
    ready();
    engine.setSpeed(1.5);
    expect(engine.speed()).toBe(1.5);
    expect(media.element.playbackRate).toBe(1.5);
    expect(media.element.defaultPlaybackRate).toBe(1.5);
    expect(media.element.preservesPitch).toBe(true);
    // A load puts the rate back to the default: the engine sets it again.
    media.element.playbackRate = 1;
    engine.load(OTHER);
    expect(media.element.playbackRate).toBe(1.5);
    expect(media.element.defaultPlaybackRate).toBe(1.5);
  });

  it('sets the volume and the mute, and follows changes made elsewhere (FR-9)', () => {
    ready();
    engine.setVolume(0.4);
    expect(media.element.volume).toBe(0.4);
    expect(engine.volume()).toBe(0.4);
    engine.toggleMute();
    expect(media.element.muted).toBe(true);
    expect(engine.muted()).toBe(true);
    media.element.muted = false;
    media.element.volume = 0.7;
    media.emit('volumechange');
    expect(engine.muted()).toBe(false);
    expect(engine.volume()).toBe(0.7);
  });

  it('keeps the volume inside 0–100% and unmutes when it is raised', () => {
    ready();
    engine.toggleMute();
    engine.setVolume(1.4);
    expect(engine.volume()).toBe(1);
    expect(engine.muted()).toBe(false);
    engine.setVolume(-1);
    expect(engine.volume()).toBe(0);
  });

  it('fades the volume inside 0–100% without touching the mute (KBC-046)', () => {
    ready();
    engine.toggleMute();
    engine.fadeVolume(0.5);
    expect(engine.volume()).toBe(0.5);
    expect(engine.muted()).toBe(true);
    engine.fadeVolume(2);
    expect(engine.volume()).toBe(1);
    engine.fadeVolume(-1);
    expect(engine.volume()).toBe(0);
    expect(media.element.muted).toBe(true);
  });

  it('keeps one element for every source (one thing plays at a time)', () => {
    ready();
    ready(OTHER);
    expect(media.calls.filter((call) => call.startsWith('load:'))).toHaveLength(
      2,
    );
    expect(engine.source()).toEqual(OTHER);
  });
});

describe('MEDIA_ELEMENT_FACTORY', () => {
  afterEach(() => window.history.replaceState({}, '', '/'));

  it('puts one hidden <audio> in the page', () => {
    const element = TestBed.inject(MEDIA_ELEMENT_FACTORY)();
    expect(element.tagName).toBe('AUDIO');
    expect(element.hidden).toBe(true);
    expect(element.isConnected).toBe(true);
    element.remove();
  });

  it('gives a <video> in development when asked, for the E2E of ADR 0025', () => {
    window.history.replaceState({}, '', '/midia/x?mediaElement=video');
    expect(mediaTagOf(document)).toBe('video');
    const element = TestBed.inject(MEDIA_ELEMENT_FACTORY)();
    expect(element.tagName).toBe('VIDEO');
    expect((element as HTMLVideoElement).playsInline).toBe(true);
    element.remove();
  });

  it('ignores any other value', () => {
    window.history.replaceState({}, '', '/midia/x?mediaElement=img');
    expect(mediaTagOf(document)).toBe('audio');
  });
});

describe('MediaEngine over many media (KBC-041 NFR-3)', () => {
  it('opens and closes 20 media with one element and no extra listeners', () => {
    document
      .querySelectorAll('[data-media-engine]')
      .forEach((element) => element.remove());
    const added = vi.spyOn(HTMLMediaElement.prototype, 'addEventListener');
    const engine = TestBed.inject(MediaEngine);
    for (let i = 0; i < 20; i++) {
      engine.load({ id: `m${i}`, title: `Palestra ${i}`, src: `/m${i}` });
      engine.unload();
    }
    const elements = document.querySelectorAll('[data-media-engine]');
    expect(elements.length).toBe(1);
    const perElement = added.mock.calls.length;
    engine.load({ id: 'again', title: 'Mais uma', src: '/again' });
    engine.unload();
    expect(added.mock.calls.length).toBe(perElement);
    added.mockRestore();
    elements.forEach((element) => element.remove());
  });
});
