import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { provideZonelessChangeDetection, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import type { MediaItem } from '@kb-chat/contracts';
import { SessionStore } from '@core/auth/session-store.js';
import {
  MEDIA_ELEMENT_FACTORY,
  MediaEngine,
  type PlayableSource,
} from '@core/media/media-engine.js';
import { ProgressSaver } from '@core/media/progress-saver.js';
import { RestrictedSkipper } from '@core/media/restricted-skipper.js';
import { SleepTimerService } from '@core/media/sleep-timer.js';
import { VOLUME_WRITABLE } from '@core/media/volume-support.js';
import { RightPanel } from '@features/shell/right-panel.js';
import {
  fakeMediaElement,
  type FakeMedia,
} from '../../../testing/fake-media-element.js';
import { ClosePlayer } from '../player/close-player.js';
import { PlayNow } from './play-now.js';

const anItem = (id: string, title: string): MediaItem =>
  ({
    parent: null,
    archived: false,
    id,
    topic: 'hermetismo',
    title,
    author: null,
    status: 'ready',
    progress: null,
    failure: null,
    durationMs: 60_000,
    bytes: 1_000,
    createdAt: '2026-10-28T12:00:00.000Z',
    canRetry: false,
    canTranscribeAgain: false,
    canUseGroq: false,
    canEdit: false,
    positionMs: 0,
    completedAt: null,
    positionUpdatedAt: null,
  }) as unknown as MediaItem;

const FIRST = anItem('11111111-1111-4111-8111-111111111111', 'Primeira');
const SECOND = anItem('22222222-2222-4222-8222-222222222222', 'Segunda');
const THIRD = anItem('33333333-3333-4333-8333-333333333333', 'Terceira');

function setUp() {
  const source = signal<PlayableSource | null>(null);
  const phase = signal<string>('idle');
  const playing = signal(false);
  const engine = {
    source,
    playback: () => ({ phase: phase() }),
    playing,
    load: vi.fn((next: PlayableSource) => {
      source.set(next);
      phase.set('loading');
    }),
    play: vi.fn(() => {
      phase.set('playing');
      playing.set(true);
    }),
    toggle: vi.fn(),
    seek: vi.fn(),
    pause: vi.fn(() => playing.set(false)),
    unload: vi.fn(() => {
      source.set(null);
      phase.set('idle');
    }),
  };
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      { provide: MediaEngine, useValue: engine },
      { provide: RestrictedSkipper, useValue: {} },
      {
        provide: ProgressSaver,
        useValue: { startFrom: () => 0, gone: () => null, saveNow: vi.fn() },
      },
      { provide: RightPanel, useValue: { close: vi.fn() } },
      // No timer here; the real one is in "PlayNow with the sleep timer" below.
      { provide: SleepTimerService, useValue: { stopsAtEnd: () => false } },
    ],
  });
  const playNow = TestBed.inject(PlayNow);
  const end = () => {
    phase.set('ended');
    playing.set(false);
    TestBed.tick();
  };
  return { playNow, engine, end };
}

describe('PlayNow: "Tocar em seguida" (v2 media-library-row-menu)', () => {
  it('plays at once when nothing is playing, and queues nothing', () => {
    const { playNow, engine } = setUp();
    expect(playNow.playNext(FIRST)).toBe(false);
    expect(engine.load).toHaveBeenCalledWith(
      expect.objectContaining({ id: FIRST.id }),
      0,
    );
    expect(playNow.upNext()).toEqual([]);
  });

  it('waits its turn after the one playing, in the order asked, once each', () => {
    const { playNow, engine, end } = setUp();
    playNow.play(FIRST);
    expect(playNow.playNext(SECOND)).toBe(true);
    expect(playNow.playNext(THIRD)).toBe(true);
    expect(playNow.playNext(SECOND)).toBe(true);
    expect(playNow.upNext().map((one) => one.title)).toEqual([
      'Terceira',
      'Segunda',
    ]);
    expect(engine.load).toHaveBeenCalledTimes(1);

    end();
    expect(engine.source()?.id).toBe(THIRD.id);
    expect(playNow.upNext().map((one) => one.title)).toEqual(['Segunda']);
    end();
    expect(engine.source()?.id).toBe(SECOND.id);
    expect(playNow.upNext()).toEqual([]);
    end();
    expect(engine.load).toHaveBeenCalledTimes(3);
  });

  it('asked for the one playing, it leaves it playing', () => {
    const { playNow, engine } = setUp();
    playNow.play(FIRST);
    expect(playNow.playNext(FIRST)).toBe(false);
    expect(engine.toggle).not.toHaveBeenCalled();
    expect(playNow.upNext()).toEqual([]);
  });
});

describe('PlayNow: "Continuar ouvindo"\'s ▶ (v2 media-library)', () => {
  it('never pauses the one playing, and plays it when it is not', () => {
    const { playNow, engine } = setUp();
    playNow.resume(FIRST);
    expect(engine.load).toHaveBeenCalledTimes(1);
    playNow.resume(FIRST);
    expect(engine.toggle).not.toHaveBeenCalled();
    expect(engine.load).toHaveBeenCalledTimes(1);
  });
});

/**
 * The real engine and the real sleep timer (review of PR #156, B1): which one hears the end
 * first must not matter.
 */
function setUpWithTimer() {
  localStorage.clear();
  const media: FakeMedia = fakeMediaElement();
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      provideHttpClient(),
      provideHttpClientTesting(),
      provideRouter([]),
      { provide: MEDIA_ELEMENT_FACTORY, useValue: () => media.element },
      { provide: SessionStore, useValue: { me: signal(null) } },
      { provide: VOLUME_WRITABLE, useValue: Promise.resolve(true) },
    ],
  });
  const engine = TestBed.inject(MediaEngine);
  const timer = TestBed.inject(SleepTimerService);
  const playNow = TestBed.inject(PlayNow);
  const playing = () => {
    media.setDuration(60);
    media.emit('loadedmetadata');
    media.emit('playing');
    TestBed.tick();
  };
  const end = () => {
    media.setPaused(true);
    media.emit('ended');
    TestBed.tick();
  };
  return { engine, timer, playNow, playing, end };
}

describe('PlayNow with the sleep timer (KBC-046 × "Tocar em seguida")', () => {
  it('with the timer at "No fim desta mídia", the end does not play the next one', async () => {
    const { engine, timer, playNow, playing, end } = setUpWithTimer();
    playNow.play(FIRST);
    playing();
    expect(playNow.playNext(SECOND)).toBe(true);
    timer.start('end-of-media');
    TestBed.tick();

    end();
    await Promise.resolve();
    TestBed.tick();

    expect(engine.source()?.id).toBe(FIRST.id);
    expect(engine.playing()).toBe(false);
    expect(timer.timer()).toEqual({ kind: 'off' });
  });

  it('without the timer, the end plays the next one as asked', () => {
    const { engine, playNow, playing, end } = setUpWithTimer();
    playNow.play(FIRST);
    playing();
    playNow.playNext(SECOND);

    end();

    expect(engine.source()?.id).toBe(SECOND.id);
  });
});

describe('PlayNow after "Fechar o player" (KBC-041 AC-11, PD-04)', () => {
  it('forgets what was asked for next: a later end plays nothing from before', () => {
    const { playNow, engine, end } = setUp();
    playNow.play(FIRST);
    playNow.playNext(SECOND);
    TestBed.inject(ClosePlayer).run(false);
    expect(playNow.upNext()).toEqual([]);

    playNow.play(THIRD);
    end();

    expect(engine.load).toHaveBeenCalledTimes(2);
    expect(engine.source()?.id).toBe(THIRD.id);
  });
});
