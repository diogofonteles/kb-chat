import { provideHttpClient } from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
  type TestRequest,
} from '@angular/common/http/testing';
import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { SessionStore } from '@core/auth/session-store.js';
import {
  fakeMediaElement,
  type FakeMedia,
} from '../../testing/fake-media-element.js';
import { aMediaItem } from '../../testing/media-fixtures.js';
import { MEDIA_ELEMENT_FACTORY, MediaEngine } from './media-engine.js';
import { ProgressSaver } from './progress-saver.js';

const A = {
  id: '11111111-1111-4111-8111-111111111111',
  title: 'Palestra',
  src: '/a',
  durationMs: 600_000,
};
const B = { ...A, id: '22222222-2222-4222-8222-222222222222', src: '/b' };
const urlOf = (id: string) => `/api/v1/media/${id}/progress`;
const T0 = '2026-10-29T10:00:00.000Z';
const savedAs = (positionMs: number, at = '2026-10-29T12:00:00.000Z') => ({
  positionMs,
  completedAt: null,
  positionUpdatedAt: at,
});
const keyOf = (email: string, id = A.id) =>
  `kb-chat.media-position.${encodeURIComponent(email)}.${id}`;

function setup(email = 'ana@example.com') {
  const media: FakeMedia = fakeMediaElement();
  const me = signal<{ email: string } | null>({ email });
  TestBed.configureTestingModule({
    providers: [
      provideHttpClient(),
      provideHttpClientTesting(),
      { provide: MEDIA_ELEMENT_FACTORY, useValue: () => media.element },
      { provide: SessionStore, useValue: { me } },
    ],
  });
  const engine = TestBed.inject(MediaEngine);
  const saver = TestBed.inject(ProgressSaver);
  const http = TestBed.inject(HttpTestingController);
  const playAt = (seconds: number) => {
    media.setCurrentTime(seconds);
    media.emit('timeupdate');
  };
  const start = (source = A) => {
    engine.load(source);
    media.setDuration(source.durationMs / 1000);
    media.emit('loadedmetadata');
    engine.play();
    media.emit('playing');
    TestBed.tick();
  };
  const pause = () => {
    media.setPaused(true);
    media.emit('pause');
    TestBed.tick();
  };
  const puts = (id = A.id): TestRequest[] =>
    http.match({ method: 'PUT', url: urlOf(id) });
  const kept = (id = A.id) => localStorage.getItem(keyOf(email, id));
  return { engine, saver, http, media, playAt, start, pause, puts, kept, me };
}

describe('ProgressSaver (KBC-041 FR-3, NFR-2)', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.useFakeTimers();
  });
  afterEach(() => vi.useRealTimers());

  it('keeps the position every second and sends it every 10 s while playing', async () => {
    const { playAt, start, puts, kept } = setup();
    start();
    for (let second = 1; second <= 35; second++) {
      playAt(second);
      await vi.advanceTimersByTimeAsync(1_000);
      // Each save answers before the next: they go one after the other.
      puts().forEach((request) =>
        request.flush(savedAs(request.request.body.positionMs)),
      );
    }
    expect(JSON.parse(kept() ?? '{}')).toMatchObject({
      positionMs: 35_000,
      delivered: false,
    });
  });

  it('sends saves of one media one after the other, never two at once', async () => {
    const { playAt, start, pause, puts } = setup();
    start();
    playAt(10);
    await vi.advanceTimersByTimeAsync(10_000);
    const first = puts();
    expect(first.length).toBe(1);
    playAt(11);
    pause();
    // The pause waits for the first save to answer.
    expect(puts()).toEqual([]);
    first[0]?.flush(savedAs(10_000));
    expect(puts()[0]?.request.body.positionMs).toBe(11_000);
  });

  it('sends at once on pause, and never the same position twice', async () => {
    const { media, playAt, start, pause, puts } = setup();
    start();
    playAt(4);
    await vi.advanceTimersByTimeAsync(1_000);
    pause();
    const [paused] = puts();
    expect(paused?.request.body.positionMs).toBe(4_000);
    paused?.flush(savedAs(4_000));
    media.setPaused(false);
    media.emit('playing');
    TestBed.tick();
    pause();
    expect(puts()).toEqual([]);
  });

  it('saves the previous media when another one is loaded', async () => {
    const { engine, playAt, start, puts } = setup();
    start();
    playAt(7);
    await vi.advanceTimersByTimeAsync(1_000);
    engine.load(B);
    TestBed.tick();
    expect(puts()[0]?.request.body.positionMs).toBe(7_000);
  });

  it('keeps a skip made while paused, so leaving sends where the person is', () => {
    const { engine, media, start, pause, puts, playAt } = setup();
    start();
    playAt(1);
    pause();
    puts()[0]?.flush(savedAs(1_000));
    engine.seek(200_000);
    media.emit('seeked');
    TestBed.tick();
    engine.load(B);
    TestBed.tick();
    expect(puts()[0]?.request.body.positionMs).toBe(200_000);
  });

  it('sends one save that outlives the page when it is hidden or goes away', async () => {
    const { playAt, start, http, kept } = setup();
    start();
    playAt(12.5);
    await vi.advanceTimersByTimeAsync(500);
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => 'hidden',
    });
    document.dispatchEvent(new Event('visibilitychange'));
    window.dispatchEvent(new Event('pagehide'));
    const sent = http.match({ method: 'PUT', url: urlOf(A.id) });
    expect(sent.length).toBe(1);
    expect(sent[0]?.request.keepalive).toBe(true);
    expect(sent[0]?.request.body.positionMs).toBe(12_500);
    // Counted as delivered: it never overrides another device later (FR-3).
    expect(JSON.parse(kept() ?? '{}').delivered).toBe(true);
    Reflect.deleteProperty(document, 'visibilityState');
  });

  it('sends a failed position again at the next chance', async () => {
    const { playAt, start, pause, puts } = setup();
    start();
    playAt(10);
    await vi.advanceTimersByTimeAsync(10_000);
    puts()[0]?.flush(null, { status: 0, statusText: 'offline' });
    pause();
    expect(puts()[0]?.request.body.positionMs).toBe(10_000);
  });

  it('never sends past the end the server knows', () => {
    const { playAt, start, pause, puts } = setup();
    start();
    playAt(600.02);
    pause();
    expect(puts()[0]?.request.body.positionMs).toBe(600_000);
  });

  it('forgets the browser copy once the server has it', async () => {
    const { playAt, start, pause, puts, kept } = setup();
    start();
    playAt(5);
    await vi.advanceTimersByTimeAsync(1_000);
    pause();
    puts()[0]?.flush(savedAs(5_000));
    expect(kept()).toBeNull();
  });

  it('saves at once when the player is closed', () => {
    const { playAt, start, puts, saver } = setup();
    start();
    playAt(3.4);
    saver.saveNow();
    expect(puts()[0]?.request.body.positionMs).toBe(3_400);
  });

  it('starts from an unsent position only if no device saved one since (AC-3)', () => {
    const { saver, puts } = setup();
    localStorage.setItem(
      keyOf('ana@example.com'),
      JSON.stringify({ positionMs: 90_000, delivered: false, basedOn: T0 }),
    );
    const item = aMediaItem({
      id: A.id,
      positionMs: 60_000,
      positionUpdatedAt: T0,
    });
    expect(saver.startFrom(item)).toBe(90_000);
    expect(puts()[0]?.request.body.positionMs).toBe(90_000);
  });

  it('starts from the server when another device saved later, and drops the stale copy', () => {
    const { saver, puts, kept } = setup();
    localStorage.setItem(
      keyOf('ana@example.com'),
      JSON.stringify({ positionMs: 2_000, delivered: false, basedOn: T0 }),
    );
    const item = aMediaItem({
      id: A.id,
      positionMs: 65_000,
      positionUpdatedAt: '2026-10-29T11:00:00.000Z',
    });
    expect(saver.startFrom(item)).toBe(65_000);
    expect(puts()).toEqual([]);
    expect(kept()).toBeNull();
  });

  it('starts from the server when the browser copy was already delivered', () => {
    const { saver, puts } = setup();
    localStorage.setItem(
      keyOf('ana@example.com'),
      JSON.stringify({ positionMs: 2_000, delivered: true, basedOn: T0 }),
    );
    expect(
      saver.startFrom(
        aMediaItem({ id: A.id, positionMs: 65_000, positionUpdatedAt: T0 }),
      ),
    ).toBe(65_000);
    expect(puts()).toEqual([]);
  });

  it('keeps each person’s copy apart in a shared browser (BR-2)', () => {
    localStorage.setItem(
      keyOf('ana@example.com'),
      JSON.stringify({ positionMs: 90_000, delivered: false, basedOn: null }),
    );
    const { saver } = setup('bruno@example.com');
    expect(
      saver.startFrom(
        aMediaItem({ id: A.id, positionMs: 0, positionUpdatedAt: null }),
      ),
    ).toBe(0);
  });

  it('ignores a damaged browser copy', () => {
    const { saver, puts } = setup();
    localStorage.setItem(keyOf('ana@example.com'), '{"positionMs":"x"}');
    expect(
      saver.startFrom(
        aMediaItem({ id: A.id, positionMs: 4_000, positionUpdatedAt: null }),
      ),
    ).toBe(4_000);
    expect(puts()).toEqual([]);
  });

  it('says when the server no longer has the media for this person', () => {
    const { start, playAt, pause, puts, saver } = setup();
    start();
    playAt(3);
    pause();
    puts()[0]?.flush(
      { error: { code: 'MEDIA_NOT_FOUND', message: 'x' } },
      { status: 404, statusText: 'Not Found' },
    );
    expect(saver.gone()).toBe(A.id);
  });

  it('sends every save so that it survives a navigation', () => {
    const { playAt, start, pause, puts } = setup();
    start();
    playAt(2);
    pause();
    expect(puts()[0]?.request.keepalive).toBe(true);
  });

  it('sends, as the page goes, a position still waiting for a media already closed', async () => {
    const { engine, playAt, start, http, saver } = setup();
    start();
    playAt(8);
    await vi.advanceTimersByTimeAsync(1_000);
    saver.saveNow();
    engine.unload();
    TestBed.tick();
    // The close's save is still on its way when the page goes: it is sent once more,
    // in a request that outlives the page.
    window.dispatchEvent(new Event('pagehide'));
    const sent = http.match({ method: 'PUT', url: urlOf(A.id) });
    expect(sent.map((request) => request.request.body.positionMs)).toEqual([
      8_000, 8_000,
    ]);
    expect(sent.every((request) => request.request.keepalive)).toBe(true);
  });

  it('sends each save on top of the server save it continues (FR-3)', () => {
    const { playAt, start, pause, puts } = setup();
    start();
    playAt(2);
    pause();
    const first = puts()[0];
    expect(first?.request.body).toEqual({ positionMs: 2_000, basedOn: null });
    first?.flush(savedAs(2_000, '2026-10-29T12:00:01.000Z'));
    playAt(5);
    TestBed.inject(ProgressSaver).saveNow();
    expect(puts()[0]?.request.body).toEqual({
      positionMs: 5_000,
      basedOn: '2026-10-29T12:00:01.000Z',
    });
  });

  it('drops its copy when another device saved since (409), and continues from that save', () => {
    const { playAt, start, pause, puts, kept } = setup();
    start();
    playAt(2);
    pause();
    puts()[0]?.flush(
      {
        error: {
          code: 'MEDIA_CONFLICT',
          message: 'x',
          details: { positionUpdatedAt: '2026-10-29T12:30:00.000Z' },
        },
      },
      { status: 409, statusText: 'Conflict' },
    );
    expect(kept()).toBeNull();
    playAt(9);
    TestBed.inject(ProgressSaver).saveNow();
    expect(puts()[0]?.request.body).toEqual({
      positionMs: 9_000,
      basedOn: '2026-10-29T12:30:00.000Z',
    });
  });

  it('handles the answer of a save sent as the tab hid, when the page stays', async () => {
    const { playAt, start, http, kept } = setup();
    start();
    playAt(4);
    await vi.advanceTimersByTimeAsync(500);
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => 'hidden',
    });
    document.dispatchEvent(new Event('visibilitychange'));
    Reflect.deleteProperty(document, 'visibilityState');
    http
      .expectOne({ method: 'PUT', url: urlOf(A.id) })
      .flush(savedAs(4_000, '2026-10-29T12:00:02.000Z'));
    // Confirmed: nothing kept, and the next save continues it.
    expect(kept()).toBeNull();
    playAt(6);
    TestBed.inject(ProgressSaver).saveNow();
    expect(
      http.expectOne({ method: 'PUT', url: urlOf(A.id) }).request.body.basedOn,
    ).toBe('2026-10-29T12:00:02.000Z');
  });

  it('never sends a position nobody moved: opened only, hidden, then closed (AC-3)', () => {
    const { engine, media, http, saver } = setup();
    saver.startFrom(
      aMediaItem({ id: A.id, positionMs: 5_000, positionUpdatedAt: T0 }),
    );
    engine.load(A, 5_000);
    media.setDuration(600);
    media.emit('loadedmetadata');
    media.emit('seeked');
    TestBed.tick();
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => 'hidden',
    });
    document.dispatchEvent(new Event('visibilitychange'));
    window.dispatchEvent(new Event('pagehide'));
    Reflect.deleteProperty(document, 'visibilityState');
    expect(http.match({ method: 'PUT', url: urlOf(A.id) })).toEqual([]);
  });

  it('after another device won (409), never sends the same old position again', () => {
    const { playAt, start, pause, puts, http } = setup();
    start();
    playAt(5);
    pause();
    puts()[0]?.flush(
      {
        error: {
          code: 'MEDIA_CONFLICT',
          message: 'x',
          details: { positionUpdatedAt: '2026-10-29T12:30:00.000Z' },
        },
      },
      { status: 409, statusText: 'Conflict' },
    );
    window.dispatchEvent(new Event('pagehide'));
    expect(http.match({ method: 'PUT', url: urlOf(A.id) })).toEqual([]);
  });
});
