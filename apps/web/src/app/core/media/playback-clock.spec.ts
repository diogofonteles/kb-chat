import { DestroyRef } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Subject } from 'rxjs';
import {
  fakeMediaElement,
  type FakeMedia,
} from '../../testing/fake-media-element.js';
import { MEDIA_ELEMENT_FACTORY, MediaEngine } from './media-engine.js';
import { ANIMATION_FRAMES, PlaybackClock } from './playback-clock.js';
import { TranscriptPreferences } from './transcript-preferences.js';

function setup() {
  const media: FakeMedia = fakeMediaElement();
  const frames = new Subject<number>();
  TestBed.configureTestingModule({
    providers: [
      { provide: MEDIA_ELEMENT_FACTORY, useValue: () => media.element },
      { provide: ANIMATION_FRAMES, useValue: frames },
    ],
  });
  const engine = TestBed.inject(MediaEngine);
  const clock = TestBed.inject(PlaybackClock);
  // A transcript on screen follows the clock.
  clock.watch(TestBed.inject(DestroyRef));
  engine.load({ id: 'm1', title: 'Palestra', src: '/m1' });
  media.setDuration(600);
  media.emit('loadedmetadata');
  media.emit('canplay');
  return { media, frames, engine, clock };
}

/** The media reports `seconds` (a `timeupdate`). */
function report(media: FakeMedia, seconds: number) {
  media.setCurrentTime(seconds);
  media.emit('timeupdate');
}

describe('PlaybackClock (ADR 0025 §4, KBC-038 NFR-1)', () => {
  it('is the reported time while paused, and asks for no frames', () => {
    const { media, frames, clock } = setup();
    report(media, 12);
    TestBed.tick();
    expect(clock.positionMs()).toBe(12_000);
    expect(frames.observed).toBe(false);
  });

  it('moves on between timeupdates while playing, at the speed', () => {
    const { media, frames, clock, engine } = setup();
    report(media, 10);
    engine.play();
    media.emit('playing');
    TestBed.tick();
    expect(frames.observed).toBe(true);
    frames.next(1_000);
    expect(clock.positionMs()).toBe(10_000);
    frames.next(1_200);
    expect(clock.positionMs()).toBe(10_200);
    report(media, 10.25);
    frames.next(1_210);
    expect(clock.positionMs()).toBe(10_250);
    engine.setSpeed(2);
    media.emit('ratechange');
    frames.next(1_310);
    expect(clock.positionMs()).toBe(10_450);
  });

  it('asks for no frames while playing with nothing that follows the time', () => {
    const media: FakeMedia = fakeMediaElement();
    const frames = new Subject<number>();
    localStorage.clear();
    TestBed.configureTestingModule({
      providers: [
        { provide: MEDIA_ELEMENT_FACTORY, useValue: () => media.element },
        { provide: ANIMATION_FRAMES, useValue: frames },
      ],
    });
    const engine = TestBed.inject(MediaEngine);
    TestBed.inject(PlaybackClock);
    engine.load({ id: 'm1', title: 'Palestra', src: '/m1' });
    media.emit('canplay');
    engine.play();
    media.emit('playing');
    TestBed.tick();
    expect(frames.observed).toBe(false);
    TestBed.inject(TranscriptPreferences).toggleCaptions();
    TestBed.tick();
    expect(frames.observed).toBe(true);
  });

  it('stops asking for frames once paused', () => {
    const { media, frames, clock, engine } = setup();
    engine.play();
    media.emit('playing');
    TestBed.tick();
    frames.next(0);
    media.setPaused(true);
    media.emit('pause');
    TestBed.tick();
    expect(frames.observed).toBe(false);
    report(media, 3);
    expect(clock.positionMs()).toBe(3_000);
  });
});
