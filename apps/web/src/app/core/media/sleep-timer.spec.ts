import { provideHttpClient } from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
} from '@angular/common/http/testing';
import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { SessionStore } from '@core/auth/session-store.js';
import {
  fakeMediaElement,
  type FakeMedia,
} from '../../testing/fake-media-element.js';
import { MEDIA_ELEMENT_FACTORY, MediaEngine } from './media-engine.js';
import { PlayerAnnouncer } from './player-announcer.js';
import { SLEEP_TIMER_CLOCK, SleepTimerService } from './sleep-timer.js';
import { VOLUME_WRITABLE } from './volume-support.js';

const SOURCE = {
  id: 'm1',
  title: 'Palestra',
  src: '/m1',
  durationMs: 3_600_000,
};

function setup(options: { volume?: boolean } = {}) {
  localStorage.clear();
  const media: FakeMedia = fakeMediaElement();
  TestBed.configureTestingModule({
    providers: [
      provideHttpClient(),
      provideHttpClientTesting(),
      { provide: MEDIA_ELEMENT_FACTORY, useValue: () => media.element },
      { provide: SessionStore, useValue: { me: signal(null) } },
      // Fake timers move Date.now() too: the real clock of the timer, under control.
      { provide: SLEEP_TIMER_CLOCK, useValue: () => Date.now() },
      {
        provide: VOLUME_WRITABLE,
        useValue: Promise.resolve(options.volume ?? true),
      },
    ],
  });
  const engine = TestBed.inject(MediaEngine);
  const timer = TestBed.inject(SleepTimerService);
  const announcer = TestBed.inject(PlayerAnnouncer);
  const http = TestBed.inject(HttpTestingController);
  engine.load(SOURCE);
  media.setDuration(3_600);
  media.emit('loadedmetadata');
  engine.play();
  media.emit('playing');
  TestBed.tick();
  /** Real time passes while the element reports its clock. */
  const pass = async (ms: number) => {
    await vi.advanceTimersByTimeAsync(ms);
    media.setCurrentTime(media.element.currentTime + ms / 1000);
    media.emit('timeupdate');
    TestBed.tick();
  };
  return { engine, timer, announcer, media, http, pass };
}

describe('SleepTimerService (KBC-046)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('counts down while playing and says so once (FR-1)', async () => {
    const { timer, announcer, pass } = setup();
    await Promise.resolve();
    timer.start(15);
    TestBed.tick();
    expect(announcer.message()).toBe('Timer para dormir: 15 minutos');
    await pass(60_000);
    expect(timer.remainingMs()).toBe(840_000);
  });

  it('turns the sound down over the last 10 s, pauses, restores it and saves (AC-1)', async () => {
    const { timer, engine, media, announcer, http, pass } = setup();
    await Promise.resolve();
    engine.setVolume(0.8);
    timer.start(5);
    // 10 s left: the fade starts from the volume the person had.
    await pass(290_000);
    expect(media.element.volume).toBeCloseTo(0.8);
    await pass(5_000);
    expect(media.element.volume).toBeCloseTo(0.4);
    await pass(5_000);
    expect(media.calls.at(-1)).toBe('pause');
    media.setPaused(true);
    media.emit('pause');
    TestBed.tick();
    expect(media.element.volume).toBeCloseTo(0.8);
    expect(timer.timer()).toEqual({ kind: 'off' });
    expect(announcer.message().trim()).toBe('Pausado pelo timer');
    expect(
      http.match({ method: 'PUT', url: '/api/v1/media/m1/progress' }).length,
    ).toBeGreaterThan(0);
  });

  it('stops counting while paused (AC-2)', async () => {
    const { timer, media, pass } = setup();
    await Promise.resolve();
    timer.start(5);
    await pass(150_000);
    media.setPaused(true);
    media.emit('pause');
    TestBed.tick();
    await pass(120_000);
    expect(timer.remainingMs()).toBe(150_000);
  });

  it('adds 5 minutes and undoes a fade that started (AC-3)', async () => {
    const { timer, engine, media, pass } = setup();
    await Promise.resolve();
    engine.setVolume(1);
    timer.start(5);
    await pass(295_000);
    await pass(2_000);
    expect(media.element.volume).toBeLessThan(1);
    timer.extend();
    TestBed.tick();
    expect(timer.remainingMs()).toBe(303_000);
    expect(media.element.volume).toBe(1);
  });

  it('turns off and gives the sound back', async () => {
    const { timer, engine, media, pass } = setup();
    await Promise.resolve();
    engine.setVolume(0.6);
    timer.start(5);
    await pass(296_000);
    timer.off();
    expect(media.element.volume).toBeCloseTo(0.6);
    expect(timer.timer()).toEqual({ kind: 'off' });
  });

  it('pauses with no fade where the volume is read-only (AC-5)', async () => {
    const { timer, media, pass } = setup({ volume: false });
    await Promise.resolve();
    timer.start(5);
    await pass(296_000);
    expect(media.element.volume).toBe(1);
    await pass(4_000);
    expect(media.calls.at(-1)).toBe('pause');
  });

  it('turns off when the player closes (AC-6, BR-2)', async () => {
    const { timer, engine } = setup();
    await Promise.resolve();
    timer.start(10);
    engine.unload();
    TestBed.tick();
    expect(timer.timer()).toEqual({ kind: 'off' });
  });

  it('pauses on time with the tab hidden, when no time update comes (NFR-1)', async () => {
    const { timer, media } = setup();
    await Promise.resolve();
    timer.start(5);
    // No timeupdate at all: only the timer's own timeout runs.
    await vi.advanceTimersByTimeAsync(300_000 + 1_000);
    expect(media.calls.at(-1)).toBe('pause');
  });

  it('ends with the media for "No fim desta mídia" (AC-4)', async () => {
    const { timer, media, announcer } = setup();
    await Promise.resolve();
    timer.start('end-of-media');
    TestBed.tick();
    expect(announcer.message()).toBe('Timer para dormir: no fim desta mídia');
    media.setPaused(true);
    media.emit('ended');
    TestBed.tick();
    expect(timer.timer()).toEqual({ kind: 'off' });
  });

  it('leaves a muted player muted: nothing to turn down (FR-2)', async () => {
    const { timer, engine, media, pass } = setup();
    await Promise.resolve();
    engine.toggleMute();
    TestBed.tick();
    timer.start(5);
    await pass(295_000);
    await pass(2_000);
    expect(media.element.muted).toBe(true);
    await pass(5_000);
    expect(media.calls.at(-1)).toBe('pause');
    expect(media.element.muted).toBe(true);
    expect(engine.muted()).toBe(true);
  });

  it('gives the sound back on a pause during the fade, and waits for play (BR-1)', async () => {
    const { timer, engine, media, pass } = setup();
    await Promise.resolve();
    engine.setVolume(1);
    timer.start(5);
    await pass(295_000);
    expect(media.element.volume).toBeLessThan(1);
    media.setPaused(true);
    media.emit('pause');
    TestBed.tick();
    expect(media.element.volume).toBe(1);
    const calls = media.calls.length;
    // Paused: no count of its own keeps running.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(vi.getTimerCount()).toBe(0);
    expect(timer.remainingMs()).toBe(5_000);
    expect(media.calls.length).toBe(calls);
    media.setPaused(false);
    media.emit('playing');
    TestBed.tick();
    await pass(1_000);
    expect(media.element.volume).toBeCloseTo(0.4);
  });

  it('says "Mais 5 minutos" and "Desligar timer" when used', async () => {
    const { timer, announcer, pass } = setup();
    await Promise.resolve();
    timer.start(5);
    await pass(270_000);
    timer.extend();
    TestBed.tick();
    expect(announcer.message()).toBe(
      'Timer para dormir: para em 5 minutos e 30 segundos',
    );
    timer.off();
    TestBed.tick();
    expect(announcer.message()).toBe('Timer desligado');
  });

  it('keeps what the person chose while on, and forgets it when off', async () => {
    const { timer } = setup();
    await Promise.resolve();
    expect(timer.choice()).toBeNull();
    timer.start('end-of-media');
    expect(timer.choice()).toBe('end-of-media');
    timer.start(30);
    expect(timer.choice()).toBe(30);
    timer.off();
    expect(timer.choice()).toBeNull();
  });
});
