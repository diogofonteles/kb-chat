import { provideHttpClient } from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
} from '@angular/common/http/testing';
import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import type { MediaBookmark } from '@kb-chat/contracts';
import { SessionStore } from '@core/auth/session-store.js';
import {
  fakeMediaElement,
  type FakeMedia,
} from '../../testing/fake-media-element.js';
import { BOOKMARK_ID, BookmarksStore, UNDO_MS } from './bookmarks-store.js';
import { MEDIA_ELEMENT_FACTORY, MediaEngine } from './media-engine.js';
import { PlayerAnnouncer } from './player-announcer.js';

const MEDIA = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const URL = `/api/v1/media/${MEDIA}/bookmarks`;
const at = '2026-10-29T10:00:00.000Z';
const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

const saved = (id: string, positionMs: number, note: string | null = null) =>
  ({
    id,
    mediaId: MEDIA,
    positionMs,
    note,
    createdAt: at,
    updatedAt: at,
  }) satisfies MediaBookmark;

function setup(existing: MediaBookmark[] = []) {
  const media: FakeMedia = fakeMediaElement();
  let next = 0;
  TestBed.configureTestingModule({
    providers: [
      provideHttpClient(),
      provideHttpClientTesting(),
      { provide: MEDIA_ELEMENT_FACTORY, useValue: () => media.element },
      { provide: SessionStore, useValue: { me: signal(null) } },
      {
        provide: BOOKMARK_ID,
        useValue: () => `00000000-0000-4000-8000-00000000000${++next}`,
      },
    ],
  });
  const engine = TestBed.inject(MediaEngine);
  const store = TestBed.inject(BookmarksStore);
  const announcer = TestBed.inject(PlayerAnnouncer);
  const http = TestBed.inject(HttpTestingController);
  engine.load({ id: MEDIA, title: 'Palestra', src: '/s', durationMs: 900_000 });
  media.setDuration(900);
  media.emit('loadedmetadata');
  TestBed.tick();
  http.expectOne({ method: 'GET', url: URL }).flush({ items: existing });
  const at = (seconds: number) => {
    media.setCurrentTime(seconds);
    media.emit('timeupdate');
    TestBed.tick();
  };
  return { engine, store, announcer, http, media, at };
}

function firstId(store: BookmarksStore): string {
  const first = store.bookmarks()[0];
  if (!first) throw new Error('no bookmark');
  return first.id;
}

describe('BookmarksStore (KBC-042)', () => {
  afterEach(() => vi.useRealTimers());

  it('lists the media’s bookmarks by position once it loads', () => {
    const { store } = setup([saved(B, 60_000), saved(A, 5_000)]);
    expect(store.mediaId()).toBe(MEDIA);
    expect(store.bookmarks().map((b) => b.id)).toEqual([A, B]);
    expect(store.positions()).toEqual([5_000, 60_000]);
  });

  it('marks 2 s back at once, without waiting for the server, and opens its note (FR-2, NFR-1)', () => {
    const { store, http, at, announcer, engine } = setup();
    at(760);
    store.mark();
    const id = '00000000-0000-4000-8000-000000000001';
    expect(store.bookmarks()).toMatchObject([{ id, positionMs: 758_000 }]);
    expect(store.unsaved().has(id)).toBe(true);
    expect(store.editing()).toBe(id);
    expect(announcer.message()).toBe('Marcador em 12:38');
    expect(engine.playing()).toBe(false);
    const post = http.expectOne({ method: 'POST', url: URL });
    expect(post.request.body).toEqual({ id, positionMs: 758_000 });
    post.flush(saved(id, 758_000));
    expect(store.unsaved().has(id)).toBe(false);
  });

  it('never marks before the start (AC-7)', () => {
    const { store, http, at } = setup();
    at(1);
    store.mark();
    expect(store.bookmarks()[0]?.positionMs).toBe(0);
    http.expectOne({ method: 'POST', url: URL });
  });

  it('sends the note only after its bookmark, with the note as it is now', () => {
    const { store, http, at } = setup();
    at(100);
    store.mark();
    const id = firstId(store);
    store.saveNote(id, '  lei do ritmo ');
    expect(store.bookmarks()[0]?.note).toBe('lei do ritmo');
    expect(store.editing()).toBeNull();
    // The bookmark is still on its way: no note yet.
    http.expectNone({ method: 'PATCH' });
    http.expectOne({ method: 'POST', url: URL }).flush(saved(id, 98_000));
    const patch = http.expectOne({ method: 'PATCH', url: `${URL}/${id}` });
    expect(patch.request.body).toEqual({ note: 'lei do ritmo' });
    patch.flush(saved(id, 98_000, 'lei do ritmo'));
  });

  it('sends nothing when the note did not change', () => {
    const { store, http } = setup([saved(A, 5_000, 'x')]);
    store.saveNote(A, ' x ');
    http.expectNone({ method: 'PATCH' });
  });

  it('keeps the bookmark and its note when the server fails, and sends both again (AC-8)', () => {
    const { store, http, at } = setup();
    at(100);
    store.mark();
    const id = firstId(store);
    store.saveNote(id, 'lei do ritmo');
    http
      .expectOne({ method: 'POST', url: URL })
      .flush(null, { status: 503, statusText: 'Unavailable' });
    http
      .expectOne({ method: 'PATCH', url: `${URL}/${id}` })
      .flush(null, { status: 404, statusText: 'Not Found' });
    expect(store.failed()).toEqual({ id, kind: 'save' });
    expect(store.editing()).toBe(id);
    expect(store.bookmarks()[0]).toMatchObject({ id, note: 'lei do ritmo' });
    expect(store.unsaved().has(id)).toBe(true);
    store.retry();
    expect(store.failed()).toBeNull();
    const again = http.expectOne({ method: 'POST', url: URL });
    expect(again.request.body).toEqual({ id, positionMs: 98_000 });
    again.flush(saved(id, 98_000));
    http
      .expectOne({ method: 'PATCH', url: `${URL}/${id}` })
      .flush(saved(id, 98_000, 'lei do ritmo'));
    expect(store.unsaved().has(id)).toBe(false);
  });

  it('deletes on screen at once and on the server after 8 s (FR-4)', async () => {
    vi.useFakeTimers();
    const { store, http, announcer } = setup([saved(A, 5_000, 'nota')]);
    store.remove(A);
    expect(store.bookmarks()).toEqual([]);
    expect(store.deleted()?.id).toBe(A);
    expect(announcer.message()).toBe('Marcador apagado');
    await vi.advanceTimersByTimeAsync(UNDO_MS - 1);
    http.expectNone({ method: 'DELETE' });
    await vi.advanceTimersByTimeAsync(1);
    http
      .expectOne({ method: 'DELETE', url: `${URL}/${A}` })
      .flush(null, { status: 204, statusText: 'No Content' });
    expect(store.deleted()).toBeNull();
  });

  it('"Desfazer" brings the same bookmark back, with its note, and sends nothing (AC-3)', async () => {
    vi.useFakeTimers();
    const { store, http, announcer } = setup([saved(A, 5_000, 'nota')]);
    store.remove(A);
    await vi.advanceTimersByTimeAsync(7_000);
    store.undo();
    expect(store.bookmarks()).toEqual([saved(A, 5_000, 'nota')]);
    expect(store.deleted()).toBeNull();
    expect(announcer.message()).toBe('Marcador de volta');
    await vi.advanceTimersByTimeAsync(UNDO_MS);
    http.expectNone({ method: 'DELETE' });
  });

  it('a second deletion sends the first one now', () => {
    const { store, http } = setup([saved(A, 1_000), saved(B, 2_000)]);
    store.remove(A);
    store.remove(B);
    http.expectOne({ method: 'DELETE', url: `${URL}/${A}` });
    expect(store.deleted()?.id).toBe(B);
  });

  it('sends a pending deletion when the media changes, and lists the new one', () => {
    const { store, http, engine } = setup([saved(A, 1_000)]);
    store.remove(A);
    engine.load({ id: OTHER, title: 'Outra', src: '/o', durationMs: 1_000 });
    TestBed.tick();
    http.expectOne({ method: 'DELETE', url: `${URL}/${A}` });
    http
      .expectOne({ method: 'GET', url: `/api/v1/media/${OTHER}/bookmarks` })
      .flush({ items: [] });
    expect(store.mediaId()).toBe(OTHER);
    expect(store.deleted()).toBeNull();
  });

  it('sends a pending deletion that outlives the page as it goes', () => {
    const { store, http } = setup([saved(A, 1_000)]);
    store.remove(A);
    window.dispatchEvent(new Event('pagehide'));
    const sent = http.expectOne({ method: 'DELETE', url: `${URL}/${A}` });
    expect(sent.request.keepalive).toBe(true);
  });

  it('brings a bookmark back when its deletion fails, and deletes it again on "Tentar de novo"', () => {
    const { store, http } = setup([saved(A, 1_000)]);
    store.remove(A);
    store.remove('missing');
    store.undo();
    store.remove(A);
    expect(store.deleted()?.id).toBe(A);
    store['commitDelete'](false);
    http
      .expectOne({ method: 'DELETE', url: `${URL}/${A}` })
      .flush(null, { status: 500, statusText: 'Error' });
    expect(store.bookmarks().map((b) => b.id)).toEqual([A]);
    expect(store.failed()).toEqual({ id: A, kind: 'delete' });
    store.retry();
    expect(store.bookmarks()).toEqual([]);
    http
      .expectOne({ method: 'DELETE', url: `${URL}/${A}` })
      .flush(null, { status: 204, statusText: 'No Content' });
    expect(store.failed()).toBeNull();
  });

  it('takes a 404 on deletion as done (never saved, or deleted elsewhere)', () => {
    const { store, http } = setup([saved(A, 1_000)]);
    store.remove(A);
    store['commitDelete'](false);
    http
      .expectOne({ method: 'DELETE', url: `${URL}/${A}` })
      .flush(null, { status: 404, statusText: 'Not Found' });
    expect(store.bookmarks()).toEqual([]);
    expect(store.failed()).toBeNull();
  });

  it('still marks when the list did not load', () => {
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
    const store = TestBed.inject(BookmarksStore);
    const http = TestBed.inject(HttpTestingController);
    store.mark();
    expect(store.bookmarks()).toEqual([]);
    engine.load({ id: MEDIA, title: 'P', src: '/s', durationMs: 1_000 });
    TestBed.tick();
    http
      .expectOne({ method: 'GET', url: URL })
      .flush(null, { status: 500, statusText: 'Error' });
    store.mark();
    expect(store.bookmarks()).toHaveLength(1);
    http.expectOne({ method: 'POST', url: URL });
  });
});
