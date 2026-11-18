import { provideZonelessChangeDetection, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import type { MediaItem } from '@kb-chat/contracts';
import { MediaEngine, type PlayableSource } from '@core/media/media-engine.js';
import { ProgressSaver } from '@core/media/progress-saver.js';
import { RestrictedSkipper } from '@core/media/restricted-skipper.js';
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
  };
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      { provide: MediaEngine, useValue: engine },
      { provide: RestrictedSkipper, useValue: {} },
      { provide: ProgressSaver, useValue: { startFrom: () => 0 } },
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
