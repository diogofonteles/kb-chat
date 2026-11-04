import { TestBed } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';
import { fakeMediaElement } from '../../../testing/fake-media-element.js';
import { TrackAudition, endRange, startRange } from './track-audition.js';

function setup() {
  TestBed.configureTestingModule({ providers: [TrackAudition] });
  const audition = TestBed.inject(TrackAudition);
  const media = fakeMediaElement('audio');
  audition.attach(media.element);
  return { audition, media };
}

describe('TrackAudition (KBC-066 FR-5)', () => {
  it('plays 2 s before to 3 s after a start, 3 s before to 2 s after an end', () => {
    expect(startRange(10_000)).toEqual({ fromMs: 8_000, toMs: 13_000 });
    expect(endRange(10_000)).toEqual({ fromMs: 7_000, toMs: 12_000 });
    expect(startRange(1_000).fromMs).toBe(0);
  });

  it('starts at the range and stops at its end', async () => {
    const { audition, media } = setup();
    audition.play({ fromMs: 8_000, toMs: 13_000 });
    media.emit('loadedmetadata');
    expect(media.element.currentTime).toBe(8);
    expect(audition.positionMs()).toBe(8_000);
    await Promise.resolve();
    media.setCurrentTime(10);
    media.emit('timeupdate');
    expect(audition.positionMs()).toBe(10_000);
    media.setCurrentTime(13.1);
    media.emit('timeupdate');
    expect(media.calls).toContain('pause');
    expect(audition.playing()).toBe(false);
  });

  it('says what is playing, and forgets it at the end of the range', async () => {
    const { audition, media } = setup();
    audition.play({ fromMs: 8_000, toMs: 13_000 }, 't1:start');
    expect(audition.playingKey()).toBe('t1:start');
    await Promise.resolve();
    media.setCurrentTime(13.1);
    media.emit('timeupdate');
    expect(audition.playingKey()).toBeNull();
  });

  it('says the newer range when another one starts', () => {
    const { audition } = setup();
    audition.play({ fromMs: 0, toMs: 5_000 }, 't1:track');
    audition.play({ fromMs: 0, toMs: 5_000 }, 't2:end');
    expect(audition.playingKey()).toBe('t2:end');
  });

  it('forgets what was playing when it stops or fails', async () => {
    const { audition, media } = setup();
    audition.play({ fromMs: 0, toMs: 5_000 }, 't1:track');
    audition.stop();
    expect(audition.playingKey()).toBeNull();
    media.element.play = () => Promise.reject(new Error('refused'));
    audition.play({ fromMs: 0, toMs: 5_000 }, 't1:track');
    await Promise.resolve();
    await Promise.resolve();
    expect(audition.playingKey()).toBeNull();
    expect(audition.failed()).toBe(true);
  });

  it('seeks only when the audio can, as the first press may come before it loaded', () => {
    const { audition, media } = setup();
    audition.play({ fromMs: 8_000, toMs: 13_000 });
    expect(media.calls).toContain('play');
    expect(media.element.currentTime).toBe(0);
    media.emit('loadedmetadata');
    expect(media.element.currentTime).toBe(8);
  });

  it('seeks at once when the audio has loaded', () => {
    const { audition, media } = setup();
    Object.defineProperty(media.element, 'readyState', {
      value: HTMLMediaElement.HAVE_METADATA,
    });
    audition.play({ fromMs: 8_000, toMs: 13_000 });
    expect(media.element.currentTime).toBe(8);
  });

  it('forgets the seek of a press replaced before the audio loaded', () => {
    const { audition, media } = setup();
    audition.play({ fromMs: 8_000, toMs: 13_000 });
    audition.play({ fromMs: 20_000, toMs: 25_000 });
    media.emit('loadedmetadata');
    expect(media.element.currentTime).toBe(20);
  });

  it('says it failed when the browser refuses to play', async () => {
    const { audition, media } = setup();
    media.playAnswer = 'fail';
    audition.play({ fromMs: 0, toMs: 1_000 });
    await new Promise((resolve) => setTimeout(resolve));
    expect(audition.failed()).toBe(true);
    expect(audition.playing()).toBe(false);
  });
});
