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

  it('keeps one element for every source (one thing plays at a time)', () => {
    ready();
    ready(OTHER);
    expect(media.calls.filter((call) => call.startsWith('load:'))).toHaveLength(
      2,
    );
    expect(engine.source()).toEqual(OTHER);
  });
});
