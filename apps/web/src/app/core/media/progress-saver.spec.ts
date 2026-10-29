import { provideHttpClient } from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
  type TestRequest,
} from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import {
  fakeMediaElement,
  type FakeMedia,
} from '../../testing/fake-media-element.js';
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

function setup() {
  localStorage.clear();
  const media: FakeMedia = fakeMediaElement();
  TestBed.configureTestingModule({
    providers: [
      provideHttpClient(),
      provideHttpClientTesting(),
      { provide: MEDIA_ELEMENT_FACTORY, useValue: () => media.element },
    ],
  });
  const engine = TestBed.inject(MediaEngine);
  const saver = TestBed.inject(ProgressSaver);
  const http = TestBed.inject(HttpTestingController);
  /** Loads `source`, plays it, and has the element report `seconds`. */
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
  const puts = (id = A.id): TestRequest[] =>
    http.match({ method: 'PUT', url: urlOf(id) });
  return { engine, saver, http, media, playAt, start, puts };
}

describe('ProgressSaver (KBC-041 FR-3, NFR-2)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('keeps the position in the browser every second and sends it every 10 s while playing', async () => {
    const { playAt, start, puts, saver } = setup();
    start();
    for (let second = 1; second <= 35; second++) {
      playAt(second);
      await vi.advanceTimersByTimeAsync(1_000);
    }
    const sent = puts();
    expect(sent.length).toBe(3);
    expect(sent.map((request) => request.request.body.positionMs)).toEqual([
      10_000, 20_000, 30_000,
    ]);
    sent.forEach((request) => request.flush(null));
    expect(saver.localPosition(A.id)).toBe(35_000);
  });

  it('sends at once on pause, and never the same position twice', async () => {
    const { media, playAt, start, puts } = setup();
    start();
    playAt(4);
    await vi.advanceTimersByTimeAsync(1_000);
    media.setPaused(true);
    media.emit('pause');
    TestBed.tick();
    const [paused] = puts();
    expect(paused?.request.body).toEqual({ positionMs: 4_000 });
    paused?.flush(null);
    media.emit('playing');
    media.setPaused(true);
    media.emit('pause');
    TestBed.tick();
    expect(puts()).toEqual([]);
  });

  it('saves the previous media when another one is loaded', async () => {
    const { engine, playAt, start, puts } = setup();
    start();
    playAt(7);
    await vi.advanceTimersByTimeAsync(1_000);
    engine.load(B);
    TestBed.tick();
    expect(puts()[0]?.request.body).toEqual({ positionMs: 7_000 });
  });

  it('saves when the tab is hidden and, with a request that outlives it, when the page goes', async () => {
    const fetch = vi.fn(() => Promise.resolve(new Response(null)));
    vi.stubGlobal('fetch', fetch);
    const { playAt, start } = setup();
    start();
    playAt(12.5);
    await vi.advanceTimersByTimeAsync(500);
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => 'hidden',
    });
    document.dispatchEvent(new Event('visibilitychange'));
    expect(fetch).toHaveBeenCalledTimes(1);
    playAt(13.5);
    window.dispatchEvent(new Event('pagehide'));
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls[1]).toEqual([
      urlOf(A.id),
      expect.objectContaining({
        keepalive: true,
        body: '{"positionMs":13500}',
      }),
    ]);
    Reflect.deleteProperty(document, 'visibilityState');
  });

  it('sends a failed position again at the next chance', async () => {
    const { media, playAt, start, puts } = setup();
    start();
    playAt(10);
    await vi.advanceTimersByTimeAsync(10_000);
    puts()[0]?.flush(null, { status: 0, statusText: 'offline' });
    media.setPaused(true);
    media.emit('pause');
    TestBed.tick();
    expect(puts()[0]?.request.body).toEqual({ positionMs: 10_000 });
  });

  it('never sends past the end the server knows', async () => {
    const { playAt, start, puts, media } = setup();
    start();
    playAt(600.02);
    media.setPaused(true);
    media.emit('pause');
    TestBed.tick();
    expect(puts()[0]?.request.body).toEqual({ positionMs: 600_000 });
  });

  it('forgets the browser copy once the server has it', async () => {
    const { playAt, start, puts, saver, media } = setup();
    start();
    playAt(5);
    await vi.advanceTimersByTimeAsync(1_000);
    media.setPaused(true);
    media.emit('pause');
    TestBed.tick();
    puts()[0]?.flush(null);
    expect(saver.localPosition(A.id)).toBeNull();
  });
});
