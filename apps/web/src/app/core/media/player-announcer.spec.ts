import { TestBed } from '@angular/core/testing';
import {
  fakeMediaElement,
  type FakeMedia,
} from '../../testing/fake-media-element.js';
import { MEDIA_ELEMENT_FACTORY, MediaEngine } from './media-engine.js';
import { ANNOUNCE_SEEK_AFTER_MS, PlayerAnnouncer } from './player-announcer.js';

function setup() {
  const media: FakeMedia = fakeMediaElement();
  TestBed.configureTestingModule({
    providers: [
      { provide: MEDIA_ELEMENT_FACTORY, useValue: () => media.element },
    ],
  });
  const engine = TestBed.inject(MediaEngine);
  const announcer = TestBed.inject(PlayerAnnouncer);
  engine.load({ id: 'm1', title: 'Palestra', src: '/m1' });
  media.setDuration(3_600);
  media.emit('loadedmetadata');
  TestBed.tick();
  return { engine, announcer, media };
}

describe('PlayerAnnouncer (KBC-041 FR-10)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('says nothing while the media only loads', () => {
    const { announcer } = setup();
    expect(announcer.message()).toBe('');
  });

  it('says "Tocando" and "Pausado" only when the element confirms them', () => {
    const { engine, announcer, media } = setup();
    engine.play();
    TestBed.tick();
    expect(announcer.message()).toBe('');
    media.emit('playing');
    TestBed.tick();
    expect(announcer.message()).toBe('Tocando');
    media.setPaused(true);
    media.emit('pause');
    TestBed.tick();
    expect(announcer.message()).toBe('Pausado');
  });

  it('says the new speed', () => {
    const { engine, announcer } = setup();
    engine.setSpeed(1.5);
    TestBed.tick();
    expect(announcer.message()).toBe('Velocidade 1,5 vezes');
    engine.setSpeed(1);
    TestBed.tick();
    expect(announcer.message()).toBe('Velocidade normal');
  });

  it('joins skips in a row into one position (AC-15)', async () => {
    const { engine, announcer, media } = setup();
    for (let i = 0; i < 3; i++) {
      engine.skip(30_000);
      media.emit('seeked');
      TestBed.tick();
      await vi.advanceTimersByTimeAsync(200);
    }
    expect(announcer.message()).toBe('');
    await vi.advanceTimersByTimeAsync(ANNOUNCE_SEEK_AFTER_MS);
    expect(announcer.message()).toBe('Posição 1 minuto e 30 segundos');
  });

  it('stays quiet while the time slider has the focus: it speaks itself', async () => {
    const { engine, announcer, media } = setup();
    announcer.setSliderFocused(true);
    engine.skip(30_000);
    media.emit('seeked');
    engine.play();
    media.emit('playing');
    TestBed.tick();
    await vi.advanceTimersByTimeAsync(ANNOUNCE_SEEK_AFTER_MS);
    expect(announcer.message()).toBe('');
  });

  it('says the same position again when a skip lands on it again', async () => {
    const { engine, announcer, media } = setup();
    engine.seek(60_000);
    media.emit('seeked');
    TestBed.tick();
    await vi.advanceTimersByTimeAsync(ANNOUNCE_SEEK_AFTER_MS);
    const first = announcer.message();
    expect(first).toBe('Posição 1 minuto');
    engine.seek(60_000);
    media.emit('seeked');
    TestBed.tick();
    await vi.advanceTimersByTimeAsync(ANNOUNCE_SEEK_AFTER_MS);
    // A live region reads a change only: the repeat differs by a trailing space.
    expect(announcer.message()).not.toBe(first);
    expect(announcer.message().trim()).toBe(first);
    expect(announcer.count()).toBe(2);
  });
});
