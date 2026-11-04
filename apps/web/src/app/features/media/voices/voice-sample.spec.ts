import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { MediaEngine } from '@core/media/media-engine.js';
import { SAMPLE_ELEMENT_FACTORY, VoiceSample } from './voice-sample.js';

const REQUEST = { voice: 2, src: '/stream', startMs: 12_000, endMs: 17_000 };

function setUp(playing = false) {
  const element = document.createElement('audio');
  const play = vi.fn(() => Promise.resolve());
  element.play = play;
  element.pause = vi.fn(() => {
    element.dispatchEvent(new Event('pause'));
  });
  const engine = {
    playing: () => playing,
    pause: vi.fn(),
    play: vi.fn(),
  };
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      VoiceSample,
      { provide: MediaEngine, useValue: engine },
      { provide: SAMPLE_ELEMENT_FACTORY, useValue: () => element },
    ],
  });
  return { sample: TestBed.inject(VoiceSample), element, play, engine };
}

describe('VoiceSample (KBC-065 FR-3)', () => {
  it('plays the time range on its own element', () => {
    const { sample, element, play } = setUp();
    sample.toggle(REQUEST);
    expect(element.getAttribute('src')).toBe('/stream#t=12,17');
    expect(play).toHaveBeenCalled();
    expect(sample.playing()).toBe(2);
  });

  it('stops at the end of the range', () => {
    const { sample, element } = setUp();
    sample.toggle(REQUEST);
    element.currentTime = 17;
    element.dispatchEvent(new Event('timeupdate'));
    expect(sample.playing()).toBeNull();
  });

  it('stops when the same button is pressed again', () => {
    const { sample } = setUp();
    sample.toggle(REQUEST);
    sample.toggle(REQUEST);
    expect(sample.playing()).toBeNull();
  });

  it("moves to another voice's sample at once", () => {
    const { sample } = setUp();
    sample.toggle(REQUEST);
    sample.toggle({ ...REQUEST, voice: 3 });
    expect(sample.playing()).toBe(3);
  });

  it('pauses what was playing and goes on after the sample', () => {
    const { sample, engine } = setUp(true);
    sample.toggle(REQUEST);
    expect(engine.pause).toHaveBeenCalled();
    expect(engine.play).not.toHaveBeenCalled();
    sample.stop();
    expect(engine.play).toHaveBeenCalledTimes(1);
  });

  it('leaves the player paused when it was', () => {
    const { sample, engine } = setUp(false);
    sample.toggle(REQUEST);
    sample.stop();
    expect(engine.play).not.toHaveBeenCalled();
  });

  it('says when the sample did not play', async () => {
    const { sample, play } = setUp();
    play.mockReturnValue(Promise.reject(new Error('refused')));
    sample.toggle(REQUEST);
    await Promise.resolve();
    await Promise.resolve();
    expect(sample.failed()).toBe(true);
    expect(sample.playing()).toBeNull();
  });
});
