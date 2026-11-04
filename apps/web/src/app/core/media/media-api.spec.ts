import { provideHttpClient } from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
} from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import type { MediaItem } from '@kb-chat/contracts';
import { SessionEvents } from '@core/auth/session-events.js';
import {
  MediaApi,
  mediaListUrl,
  mediaStreamUrl,
  mediaUrl,
} from './media-api.js';
import { TUS_UPLOAD } from './tus-upload.js';
import { FakeTus } from '../../testing/fake-tus.js';

const ITEM: MediaItem = {
  parent: null,
  archived: false,
  id: '11111111-1111-4111-8111-111111111111',
  topic: 'hermetismo',
  title: 'Palestra',
  author: null,
  status: 'queued',
  progress: null,
  failure: null,
  durationMs: null,
  bytes: null,
  createdAt: '2026-10-28T12:00:00.000Z',
  canRetry: false,
  canTranscribeAgain: false,
  canEdit: false,
  positionMs: 0,
  completedAt: null,
  positionUpdatedAt: null,
  transcription: {
    status: 'none',
    confidence: null,
    version: null,
    transcriber: 'none',
    transcriberOffSince: null,
    lastAttemptFailed: false,
  },
};

function setup() {
  const tus = new FakeTus();
  TestBed.configureTestingModule({
    providers: [
      provideHttpClient(),
      provideHttpClientTesting(),
      { provide: TUS_UPLOAD, useValue: tus.factory },
    ],
  });
  return {
    api: TestBed.inject(MediaApi),
    http: TestBed.inject(HttpTestingController),
    tus,
  };
}

describe('media URLs', () => {
  it('encodes nested collection slugs and ids', () => {
    expect(mediaListUrl('a/b')).toBe('/api/v1/topics/a%2Fb/media');
    expect(mediaUrl('x y')).toBe('/api/v1/media/x%20y');
    expect(mediaStreamUrl('id')).toBe('/api/v1/media/id/stream');
  });
});

describe('MediaApi', () => {
  afterEach(() => TestBed.inject(HttpTestingController).verify());

  it('creates an item and parses it', () => {
    const { api, http } = setup();
    const seen: MediaItem[] = [];
    api
      .create('hermetismo', {
        title: 'P',
        author: null,
        fileName: 'p.mp3',
        bytes: 3,
      })
      .subscribe((item) => seen.push(item));
    const call = http.expectOne('/api/v1/topics/hermetismo/media');
    expect(call.request.method).toBe('POST');
    call.flush(ITEM);
    expect(seen).toEqual([ITEM]);
  });

  it('sends over tus in parts of 8 MB, with the CSRF header, then answers the item', () => {
    const { api, http, tus } = setup();
    const events: unknown[] = [];
    api
      .upload(ITEM.id, new Blob(['abc']))
      .subscribe((event) => events.push(event));
    const session = tus.last;
    expect(session.started).toBe(true);
    expect(session.options.uploadUrl).toBe(`/api/v1/media/${ITEM.id}/upload`);
    expect(session.options.chunkSize).toBe(8 * 1024 ** 2);
    expect(session.options.headers?.['x-requested-with']).toBe('kb-chat');
    session.progress(1, 3);
    session.succeed();
    http.expectOne({ method: 'GET', url: mediaUrl(ITEM.id) }).flush(ITEM);
    expect(events).toEqual([
      { kind: 'progress', loaded: 1, total: 3 },
      { kind: 'done', item: ITEM },
    ]);
  });

  it('asks about a file before sending it', () => {
    const { api, http } = setup();
    const seen: unknown[] = [];
    const request = { sha256: 'a'.repeat(64), bytes: 3, durationMs: null };
    api.check('hermetismo', request).subscribe((check) => seen.push(check));
    const call = http.expectOne({
      method: 'POST',
      url: '/api/v1/topics/hermetismo/media/check',
    });
    expect(call.request.body).toEqual(request);
    call.flush({ verdict: 'new' });
    expect(seen).toEqual([{ verdict: 'new' }]);
  });

  it('stops the upload when unsubscribed', () => {
    const { api, tus } = setup();
    const sending = api.upload(ITEM.id, new Blob(['a'])).subscribe();
    sending.unsubscribe();
    expect(tus.last.aborted).toBe(true);
  });

  it('ends the session on a 401 during the upload', () => {
    const { api, tus } = setup();
    const expired = vi.fn();
    TestBed.inject(SessionEvents).expired$.subscribe(expired);
    const failed = vi.fn();
    api.upload(ITEM.id, new Blob(['a'])).subscribe({ error: failed });
    tus.last.fail(401);
    expect(expired).toHaveBeenCalledTimes(1);
    expect(failed).toHaveBeenCalledTimes(1);
  });

  it('passes other upload errors on as HTTP errors, with the status', () => {
    const { api, tus } = setup();
    const expired = vi.fn();
    TestBed.inject(SessionEvents).expired$.subscribe(expired);
    const failed = vi.fn();
    api.upload(ITEM.id, new Blob(['a'])).subscribe({ error: failed });
    tus.last.fail(
      410,
      '{"error":{"code":"MEDIA_UPLOAD_EXPIRED","message":"x"}}',
    );
    expect(expired).not.toHaveBeenCalled();
    expect(failed.mock.calls[0]?.[0]).toMatchObject({ status: 410 });
  });

  it('reads a broken connection as status 0', () => {
    const { api, tus } = setup();
    const failed = vi.fn();
    api.upload(ITEM.id, new Blob(['a'])).subscribe({ error: failed });
    tus.last.fail();
    expect(failed.mock.calls[0]?.[0]).toMatchObject({ status: 0 });
  });

  describe('when the browser knows the network is gone (AC-1)', () => {
    const offline = () =>
      vi.spyOn(window.navigator, 'onLine', 'get').mockReturnValue(false);
    const networkBack = (cut: ReturnType<typeof offline>) => {
      cut.mockReturnValue(true);
      window.dispatchEvent(new Event('online'));
    };

    afterEach(() => vi.restoreAllMocks());

    it('waits for the connection and goes on by itself, however long it takes', () => {
      const { api, http, tus } = setup();
      const cut = offline();
      const events: unknown[] = [];
      const failed = vi.fn();
      api
        .upload(ITEM.id, new Blob(['a']))
        .subscribe({ next: (event) => events.push(event), error: failed });
      expect(tus.last.starts).toBe(1);

      tus.last.fail();
      expect(failed).not.toHaveBeenCalled();
      expect(events).toEqual([{ kind: 'offline' }]);
      expect(tus.last.starts).toBe(1);

      networkBack(cut);
      expect(tus.last.starts).toBe(2);
      tus.last.succeed();
      http.expectOne(mediaUrl(ITEM.id)).flush(ITEM);
      expect(events.at(-1)).toEqual({ kind: 'done', item: ITEM });
    });

    it('resumes once for each cut', () => {
      const { api, tus } = setup();
      const cut = offline();
      api.upload(ITEM.id, new Blob(['a'])).subscribe();
      tus.last.fail();
      networkBack(cut);
      window.dispatchEvent(new Event('online'));
      expect(tus.last.starts).toBe(2);
    });

    it('stops waiting when unsubscribed', () => {
      const { api, tus } = setup();
      const cut = offline();
      const sending = api.upload(ITEM.id, new Blob(['a'])).subscribe();
      tus.last.fail();
      sending.unsubscribe();
      networkBack(cut);
      expect(tus.last.starts).toBe(1);
      expect(tus.last.aborted).toBe(true);
    });

    it('still passes on an answer from the server', () => {
      const { api, tus } = setup();
      offline();
      const failed = vi.fn();
      api.upload(ITEM.id, new Blob(['a'])).subscribe({ error: failed });
      tus.last.fail(403);
      expect(failed.mock.calls[0]?.[0]).toMatchObject({ status: 403 });
    });
  });

  it('retries and removes', () => {
    const { api, http } = setup();
    api.retry(ITEM.id).subscribe();
    http
      .expectOne({ method: 'POST', url: `/api/v1/media/${ITEM.id}/retry` })
      .flush(ITEM);
    api.remove(ITEM.id).subscribe();
    http
      .expectOne({ method: 'DELETE', url: `/api/v1/media/${ITEM.id}` })
      .flush(null);
  });
});
