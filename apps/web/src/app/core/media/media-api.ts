import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import {
  MEDIA_UPLOAD_PART_BYTES,
  mediaItemSchema,
  uploadCheckSchema,
  type CreateMediaRequest,
  type MediaItem,
  type UpdateMediaRequest,
  type UploadCheck,
  type UploadCheckRequest,
} from '@kb-chat/contracts';
import { CSRF } from '@core/auth/auth-interceptor.js';
import { SessionEvents } from '@core/auth/session-events.js';
import { Observable, catchError, concat, map, throwError } from 'rxjs';
import { TUS_UPLOAD, toHttpError } from './tus-upload.js';

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

/** How many times tus tries again after a failure, and when: about two minutes offline. */
const RETRY_DELAYS_MS = [0, 1_000, 3_000, 5_000, 10_000, 20_000, 30_000, 60_000];

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
  private readonly tus = inject(TUS_UPLOAD);
  private readonly session = inject(SessionEvents);

  create(topic: string, request: CreateMediaRequest): Observable<MediaItem> {
    return this.http
      .post(mediaListUrl(topic), request)
      .pipe(map((body) => mediaItemSchema.parse(body)));
  }

  /** What a chosen file is here, before anything is sent (KBC-035 FR-1, FR-3). */
  check(topic: string, request: UploadCheckRequest): Observable<UploadCheck> {
    return this.http
      .post(`${mediaListUrl(topic)}/check`, request)
      .pipe(map((body) => uploadCheckSchema.parse(body)));
  }

  /**
   * Sends the file over tus from wherever the server stopped (KBC-035 FR-2), and answers
   * the item once it has every byte. Unsubscribing stops; what arrived stays on the server.
   */
  upload(id: string, file: Blob): Observable<UploadEvent> {
    const done = this.http.get(mediaUrl(id)).pipe(
      map((body): UploadEvent => {
        return { kind: 'done', item: mediaItemSchema.parse(body) };
      }),
    );
    return concat(this.sendParts(id, file), done).pipe(
      catchError((err: unknown) => {
        if (err instanceof HttpErrorResponse && err.status === 401)
          this.session.expired$.next();
        return throwError(() => err);
      }),
    );
  }

  private sendParts(id: string, file: Blob): Observable<UploadEvent> {
    return new Observable<UploadEvent>((subscriber) => {
      const session = this.tus(file, {
        uploadUrl: `${mediaUrl(id)}/upload`,
        chunkSize: MEDIA_UPLOAD_PART_BYTES,
        retryDelays: RETRY_DELAYS_MS,
        storeFingerprintForResuming: false,
        headers: { [CSRF.header]: CSRF.value },
        onProgress: (loaded, total) =>
          subscriber.next({ kind: 'progress', loaded, total }),
        onSuccess: () => subscriber.complete(),
        onError: (err) => subscriber.error(toHttpError(err)),
      });
      session.start();
      return () => void session.abort();
    });
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

  /** `cascade`: the person saw the tracks that go with the recording (KBC-068). */
  remove(id: string, options: { cascade?: boolean } = {}): Observable<unknown> {
    return this.http.delete(
      options.cascade ? `${mediaUrl(id)}?cascade=true` : mediaUrl(id),
    );
  }

}
