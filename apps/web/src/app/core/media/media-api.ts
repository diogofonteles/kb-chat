import {
  HttpClient,
  HttpErrorResponse,
  HttpEventType,
  HttpHeaders,
  HttpRequest,
  HttpXhrBackend,
  type HttpBackend,
  type HttpEvent,
} from '@angular/common/http';
import { Injectable, InjectionToken, inject } from '@angular/core';
import {
  mediaItemSchema,
  type CreateMediaRequest,
  type MediaItem,
  type UpdateMediaRequest,
} from '@kb-chat/contracts';
import { CSRF } from '@core/auth/auth-interceptor.js';
import { SessionEvents } from '@core/auth/session-events.js';
import { catchError, filter, map, throwError, type Observable } from 'rxjs';

/** API URLs of the media library (ADR 0022); slugs and ids are always encoded. */
export const mediaListUrl = (topic: string): string =>
  `/api/v1/topics/${encodeURIComponent(topic)}/media`;
export const mediaUrl = (id: string): string =>
  `/api/v1/media/${encodeURIComponent(id)}`;
export const mediaStreamUrl = (id: string): string => `${mediaUrl(id)}/stream`;
/** The current transcript and its subtitles (KBC-038). */
export const mediaTranscriptUrl = (id: string): string =>
  `${mediaUrl(id)}/transcript`;
export const mediaSubtitlesUrl = (id: string): string =>
  `${mediaUrl(id)}/subtitles.vtt`;
/** The player page of a media, as a link to share (with `?t=`, KBC-038 FR-5). */
export const mediaPagePath = (id: string): string =>
  `/midia/${encodeURIComponent(id)}`;

/**
 * The backend uploads go through: XHR, since the app's fetch backend reports no upload
 * progress. Tests swap it for the testing backend.
 */
export const MEDIA_UPLOAD_BACKEND = new InjectionToken<HttpBackend>(
  'MEDIA_UPLOAD_BACKEND',
  {
    providedIn: 'root',
    factory: () => inject(HttpXhrBackend),
  },
);

/** Where an upload is: bytes sent so far, or the item once the server has it. */
export type UploadEvent =
  | {
      readonly kind: 'progress';
      readonly loaded: number;
      readonly total: number;
    }
  | { readonly kind: 'done'; readonly item: MediaItem };

/** Writes to the media library; lists and items are read with httpResource and the URLs. */
@Injectable({ providedIn: 'root' })
export class MediaApi {
  private readonly http = inject(HttpClient);
  /**
   * Uploads go over XHR: the app's HttpClient uses fetch, which reports no upload progress.
   * This client skips the interceptors, so it adds the CSRF header and reports a 401 itself.
   */
  private readonly xhr = new HttpClient(inject(MEDIA_UPLOAD_BACKEND));
  private readonly session = inject(SessionEvents);

  create(topic: string, request: CreateMediaRequest): Observable<MediaItem> {
    return this.http
      .post(mediaListUrl(topic), request)
      .pipe(map((body) => mediaItemSchema.parse(body)));
  }

  /** Sends the file; unsubscribing cancels the upload (XHR abort). */
  upload(id: string, file: Blob): Observable<UploadEvent> {
    const request = new HttpRequest('PUT', `${mediaUrl(id)}/file`, file, {
      reportProgress: true,
      headers: new HttpHeaders({
        'content-type': 'application/octet-stream',
        [CSRF.header]: CSRF.value,
      }),
    });
    return this.xhr.request(request).pipe(
      map((event) => this.toUploadEvent(event, file.size)),
      filter((event): event is UploadEvent => event !== null),
      catchError((err: unknown) => {
        if (err instanceof HttpErrorResponse && err.status === 401)
          this.session.expired$.next();
        return throwError(() => err);
      }),
    );
  }

  /** Changes its title, author or collection (KBC-050); what is left out stays. */
  update(id: string, request: UpdateMediaRequest): Observable<MediaItem> {
    return this.http
      .patch(mediaUrl(id), request)
      .pipe(map((body) => mediaItemSchema.parse(body)));
  }

  /** A master asks for a new transcription; the current one stays until it is ready. */
  transcribeAgain(id: string): Observable<MediaItem> {
    return this.http
      .post(`${mediaUrl(id)}/transcription`, null)
      .pipe(map((body) => mediaItemSchema.parse(body)));
  }

  retry(id: string): Observable<MediaItem> {
    return this.http
      .post(`${mediaUrl(id)}/retry`, null)
      .pipe(map((body) => mediaItemSchema.parse(body)));
  }

  remove(id: string): Observable<unknown> {
    return this.http.delete(mediaUrl(id));
  }

  private toUploadEvent(
    event: HttpEvent<unknown>,
    size: number,
  ): UploadEvent | null {
    if (event.type === HttpEventType.UploadProgress)
      return {
        kind: 'progress',
        loaded: event.loaded,
        total: event.total ?? size,
      };
    if (event.type === HttpEventType.Response)
      return { kind: 'done', item: mediaItemSchema.parse(event.body) };
    return null;
  }
}
