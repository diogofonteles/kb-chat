import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
