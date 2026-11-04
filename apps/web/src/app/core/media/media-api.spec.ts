import {
  HttpBackend,
  HttpEventType,
  provideHttpClient,
} from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
} from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import type { MediaItem } from '@kb-chat/contracts';
import { SessionEvents } from '@core/auth/session-events.js';
import {
  MEDIA_UPLOAD_BACKEND,
  MediaApi,
  mediaListUrl,
  mediaStreamUrl,
  mediaUrl,
} from './media-api.js';

const ITEM: MediaItem = {
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
  },
};

function setup() {
  TestBed.configureTestingModule({
    providers: [
      provideHttpClient(),
      provideHttpClientTesting(),
      {
        provide: MEDIA_UPLOAD_BACKEND,
        useFactory: () => TestBed.inject(HttpBackend),
      },
    ],
  });
  return {
    api: TestBed.inject(MediaApi),
    http: TestBed.inject(HttpTestingController),
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

  it('uploads the bytes with the CSRF header and reports progress then the item', () => {
    const { api, http } = setup();
    const events: unknown[] = [];
    api
      .upload(ITEM.id, new Blob(['abc']))
      .subscribe((event) => events.push(event));
    const call = http.expectOne(`/api/v1/media/${ITEM.id}/file`);
    expect(call.request.method).toBe('PUT');
    expect(call.request.headers.get('x-requested-with')).toBe('kb-chat');
    expect(call.request.headers.get('content-type')).toBe(
      'application/octet-stream',
    );
    expect(call.request.reportProgress).toBe(true);
    call.event({ type: HttpEventType.UploadProgress, loaded: 1, total: 3 });
    call.event({ type: HttpEventType.UploadProgress, loaded: 2 });
    call.flush(ITEM);
    expect(events).toEqual([
      { kind: 'progress', loaded: 1, total: 3 },
      { kind: 'progress', loaded: 2, total: 3 },
      { kind: 'done', item: ITEM },
    ]);
  });

  it('ends the session on a 401 during the upload', () => {
    const { api, http } = setup();
    const expired = vi.fn();
    TestBed.inject(SessionEvents).expired$.subscribe(expired);
    const failed = vi.fn();
    api.upload(ITEM.id, new Blob(['a'])).subscribe({ error: failed });
    http
      .expectOne(`/api/v1/media/${ITEM.id}/file`)
      .flush(null, { status: 401, statusText: 'x' });
    expect(expired).toHaveBeenCalledTimes(1);
    expect(failed).toHaveBeenCalledTimes(1);
  });

  it('passes other upload errors on without ending the session', () => {
    const { api, http } = setup();
    const expired = vi.fn();
    TestBed.inject(SessionEvents).expired$.subscribe(expired);
    const failed = vi.fn();
    api.upload(ITEM.id, new Blob(['a'])).subscribe({ error: failed });
    http
      .expectOne(`/api/v1/media/${ITEM.id}/file`)
      .flush(null, { status: 413, statusText: 'x' });
    expect(expired).not.toHaveBeenCalled();
    expect(failed).toHaveBeenCalledTimes(1);
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
