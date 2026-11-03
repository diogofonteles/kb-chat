import { provideHttpClient } from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
} from '@angular/common/http/testing';
import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import type { MediaSilences } from '@kb-chat/contracts';
import { SessionStore } from '@core/auth/session-store.js';
import {
  fakeMediaElement,
  type FakeMedia,
} from '../../testing/fake-media-element.js';
import { MEDIA_ELEMENT_FACTORY, MediaEngine } from './media-engine.js';
import { PlayerAnnouncer } from './player-announcer.js';
import { SilenceSkipper } from './silence-skipper.js';

const SOURCE = { id: 'm1', title: 'Palestra', src: '/m1', durationMs: 60_000 };
const SILENCES_URL = '/api/v1/media/m1/silences';

/** Pauses of 0.5 s, 1.2 s, 3 s and 2 s (the AC-1 audio, and one more after it). */
const MAP: MediaSilences = {
  status: 'ready',
  version: 1,
  minSilenceMs: 1_000,
  intervals: [
    { startMs: 1_000, endMs: 1_500 },
    { startMs: 2_500, endMs: 3_700 },
    { startMs: 4_700, endMs: 7_700 },
    { startMs: 10_000, endMs: 12_000 },
  ],
};

const STEP_MS = 5;

function setup(answer: MediaSilences | 'error' = MAP) {
  const media: FakeMedia = fakeMediaElement();
  TestBed.configureTestingModule({
    providers: [
      provideHttpClient(),
      provideHttpClientTesting(),
      { provide: MEDIA_ELEMENT_FACTORY, useValue: () => media.element },
      { provide: SessionStore, useValue: { me: signal(null) } },
    ],
  });
  const engine = TestBed.inject(MediaEngine);
  const skipper = TestBed.inject(SilenceSkipper);
  const announcer = TestBed.inject(PlayerAnnouncer);
  const http = TestBed.inject(HttpTestingController);
  engine.load(SOURCE);
  media.setDuration(60);
  media.emit('loadedmetadata');
  TestBed.tick();
  const read = http.expectOne(SILENCES_URL);
  if (answer === 'error')
    read.flush('boom', { status: 500, statusText: 'Server Error' });
  else read.flush(answer);
  TestBed.tick();
  /** Where each seek of the element happened, and to where (ms). */
  const jumps: { atMs: number; toMs: number }[] = [];
  /**
   * Plays for `ms` of real time: the element's clock moves with the fake timers, a seek
   * lands at once and `timeupdate` fires every 250 ms, as in a browser.
   */
  const play = async (ms: number) => {
    let sinceUpdate = 0;
    for (let passed = 0; passed < ms; passed += STEP_MS) {
      const before = media.element.currentTime;
      const seeks = media.calls.length;
      await vi.advanceTimersByTimeAsync(STEP_MS);
      if (media.calls.length > seeks) {
        jumps.push({
          atMs: Math.round(before * 1000),
          toMs: Math.round(media.element.currentTime * 1000),
        });
        media.emit('seeked');
      } else media.setCurrentTime(before + (STEP_MS / 1000) * engine.speed());
      sinceUpdate += STEP_MS;
      if (sinceUpdate >= 250) {
        sinceUpdate = 0;
        media.emit('timeupdate');
      }
      TestBed.tick();
    }
  };
  const startAt = async (ms: number) => {
    media.setCurrentTime(ms / 1000);
    media.emit('timeupdate');
    engine.play();
    media.emit('playing');
    TestBed.tick();
    await vi.advanceTimersByTimeAsync(0);
  };
  const turnOn = () => {
    skipper.setEnabled(true);
    TestBed.tick();
    http.match('/api/v1/media/preferences');
  };
  return {
    engine,
    skipper,
    announcer,
    media,
    http,
    jumps,
    play,
    startAt,
    turnOn,
  };
}

describe('SilenceSkipper (KBC-044)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('jumps from 0.15 s into the 3 s pause to 0.15 s before its end and adds it up (AC-2)', async () => {
    const { skipper, jumps, play, startAt, turnOn } = setup();
    turnOn();
    await startAt(4_000);
    await play(1_200);
    expect(jumps).toHaveLength(1);
    const [jump] = jumps;
    expect(jump?.toMs).toBe(7_550);
    // NFR-2: at most 150 ms into the pause (it starts at 4 700 ms).
    expect(jump?.atMs).toBeGreaterThanOrEqual(4_820);
    expect(jump?.atMs).toBeLessThanOrEqual(4_850);
    expect(skipper.savedMs()).toBeGreaterThanOrEqual(2_700);
    expect(skipper.savedMs()).toBeLessThanOrEqual(2_730);
  });

  it('shortens the 1.2 s pause and keeps the 0.5 s one (BR-1)', async () => {
    const { jumps, play, startAt, turnOn } = setup();
    turnOn();
    await startAt(0);
    await play(3_000);
    expect(jumps.map((jump) => jump.toMs)).toEqual([3_550]);
  });

  it('jumps once per pause and then the next one, never back (FR-4)', async () => {
    const { jumps, play, startAt, turnOn } = setup();
    turnOn();
    await startAt(4_000);
    await play(4_000);
    expect(jumps.map((jump) => jump.toMs)).toEqual([7_550, 11_850]);
  });

  it('does nothing with the option off (AC-3, BR-2)', async () => {
    const { skipper, jumps, play, startAt } = setup();
    expect(skipper.enabled()).toBe(false);
    await startAt(0);
    await play(9_000);
    expect(jumps).toEqual([]);
    expect(skipper.savedMs()).toBe(0);
  });

  it('respects a jump of the person into a pause and shortens the next one (AC-4, BR-3)', async () => {
    const { engine, media, jumps, play, startAt, turnOn } = setup();
    turnOn();
    await startAt(3_000);
    engine.seek(5_000);
    media.emit('seeked');
    TestBed.tick();
    await play(5_500);
    // The 3 s pause the person jumped into is heard to its end; the next is shortened.
    expect(engine.seeksLanded()).toBe(1);
    expect(jumps.map((jump) => jump.toMs)).toEqual([11_850]);
  });

  it('keeps the original timeline: the time and the length are the media’s (AC-7, FR-5)', async () => {
    const { engine, media, skipper, play, startAt, turnOn } = setup();
    turnOn();
    await startAt(4_000);
    await play(1_000);
    expect(skipper.savedMs()).toBeGreaterThan(2_000);
    engine.seek(50_000);
    media.emit('seeked');
    media.emit('timeupdate');
    TestBed.tick();
    expect(engine.playback().currentMs).toBe(50_000);
    expect(engine.playback().durationMs).toBe(60_000);
  });

  it('never announces a skipped pause as a new position, but says when it is turned on or off', async () => {
    const { engine, skipper, announcer, play, startAt, turnOn } = setup();
    turnOn();
    expect(announcer.message()).toBe('Encurtar silêncios ligado');
    await startAt(4_000);
    await play(2_000);
    expect(engine.seeksLanded()).toBe(0);
    expect(announcer.message()).toBe('Tocando');
    skipper.setEnabled(false);
    expect(announcer.message()).toBe('Encurtar silêncios desligado');
  });

  it('waits half the time at 2× speed', async () => {
    const { engine, jumps, play, startAt, turnOn } = setup();
    turnOn();
    engine.setSpeed(2);
    await startAt(4_000);
    await play(450);
    expect(jumps.map((jump) => jump.toMs)).toEqual([7_550]);
  });

  it('says why there is nothing to skip: being measured, no long pauses, unreadable', () => {
    expect(
      setup({
        ...MAP,
        status: 'pending',
        version: null,
        intervals: [],
      }).skipper.mapState(),
    ).toBe('pending');
    TestBed.resetTestingModule();
    expect(
      setup({
        ...MAP,
        intervals: [{ startMs: 0, endMs: 900 }],
      }).skipper.mapState(),
    ).toBe('none');
    TestBed.resetTestingModule();
    expect(setup('error').skipper.mapState()).toBe('unavailable');
    TestBed.resetTestingModule();
    expect(setup().skipper.mapState()).toBe('ready');
  });

  it('counts the time saved per media: another media starts at zero', async () => {
    const { engine, skipper, http, play, startAt, turnOn } = setup();
    turnOn();
    await startAt(4_000);
    await play(1_000);
    expect(skipper.savedMs()).toBeGreaterThan(0);
    engine.load({ ...SOURCE, id: 'm2', src: '/m2' });
    TestBed.tick();
    expect(skipper.mapState()).toBe('loading');
    expect(skipper.savedMs()).toBe(0);
    http.expectOne('/api/v1/media/m2/silences').flush(MAP);
    TestBed.tick();
    expect(skipper.mapState()).toBe('ready');
  });
});
