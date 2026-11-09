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

  describe('a word chosen in the text (KBC-093 BR-17)', () => {
    const loaded = (element: HTMLMediaElement) =>
      Object.defineProperty(element, 'readyState', {
        value: HTMLMediaElement.HAVE_METADATA,
      });

    it('AC-40: playing, it goes on from the word, at least to the end asked', async () => {
      const { audition, media } = setup();
      loaded(media.element);
      audition.play({ fromMs: 30_000, toMs: 40_000 }, 't1:track');
      await Promise.resolve();
      const plays = media.calls.filter((call) => call === 'play').length;

      audition.seek(72_000, 90_000);

      expect(media.element.currentTime).toBe(72);
      expect(audition.positionMs()).toBe(72_000);
      expect(audition.playing()).toBe(true);
      expect(media.calls.filter((call) => call === 'play')).toHaveLength(plays);
      media.setCurrentTime(85);
      media.emit('timeupdate');
      expect(audition.playing()).toBe(true);
      media.setCurrentTime(90.1);
      media.emit('timeupdate');
      expect(audition.playing()).toBe(false);
    });

    it('AC-25: playing, a word after the track (whole transcript) goes on to the recording end', async () => {
      const { audition, media } = setup();
      loaded(media.element);
      audition.play({ fromMs: 0, toMs: 30_000 }, 't1:track');
      await Promise.resolve();

      audition.seek(40_000, 30_000);

      expect(media.element.currentTime).toBe(40);
      expect(audition.playing()).toBe(true);
      media.setCurrentTime(40.3);
      media.emit('timeupdate');
      expect(media.calls).not.toContain('pause');
      expect(audition.playing()).toBe(true);
      expect(audition.positionMs()).toBe(40_300);
      media.setCurrentTime(3_600);
      media.emit('timeupdate');
      expect(audition.playing()).toBe(true);
      media.emit('ended');
      expect(audition.playing()).toBe(false);
    });

    it('AC-25: playing, a word before the track goes on from it to the track end', async () => {
      const { audition, media } = setup();
      loaded(media.element);
      audition.play({ fromMs: 60_000, toMs: 90_000 }, 't1:track');
      await Promise.resolve();

      audition.seek(20_000, 90_000);

      media.setCurrentTime(20.5);
      media.emit('timeupdate');
      expect(audition.playing()).toBe(true);
      media.setCurrentTime(90.1);
      media.emit('timeupdate');
      expect(audition.playing()).toBe(false);
    });

    it('AC-41: paused, it waits at the word, and the whole track then starts there', () => {
      const { audition, media } = setup();
      loaded(media.element);

      audition.seek(72_000, 90_000);

      expect(media.element.currentTime).toBe(72);
      expect(audition.playing()).toBe(false);
      expect(media.calls).not.toContain('play');
      expect(audition.cuedMs()).toBe(72_000);
      audition.play({ fromMs: 60_000, toMs: 90_000 }, null, { fromCue: true });
      expect(audition.positionMs()).toBe(72_000);
      expect(audition.cuedMs()).toBeNull();
    });

    it('a cue outside the track, or a range that is not the track, starts at its own start', () => {
      const { audition } = setup();
      audition.seek(10_000, 20_000);
      audition.play({ fromMs: 60_000, toMs: 90_000 }, null, { fromCue: true });
      expect(audition.positionMs()).toBe(60_000);
      audition.stop();
      audition.seek(72_000, 90_000);
      audition.play({ fromMs: 58_000, toMs: 63_000 });
      expect(audition.positionMs()).toBe(58_000);
    });

    it('waits for the audio to load before moving it', () => {
      const { audition, media } = setup();
      audition.seek(72_000, 90_000);
      expect(media.element.currentTime).toBe(0);
      expect(audition.cuedMs()).toBe(72_000);
      media.emit('loadedmetadata');
      expect(media.element.currentTime).toBe(72);
    });
  });
});
