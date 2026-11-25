import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import {
  MEDIA_UPLOAD_PART_BYTES,
  chooseRecordingsResponseSchema,
  createDocumentUploadResponseSchema,
  documentBatchSchema,
  documentUploadListSchema,
  type ChooseRecordingsResponse,
  type CreateDocumentUploadRequest,
  type CreateDocumentUploadResponse,
  type DocumentBatch,
  type DocumentUploadList,
} from '@kb-chat/contracts';
import { BusyWork } from '@core/app-version/busy-work.js';
import { CSRF } from '@core/auth/auth-interceptor.js';
import { TUS_UPLOAD, toHttpError } from '@core/media/tus-upload.js';
import { Observable, map } from 'rxjs';

/** "Documentos em processamento" (KBC-149): one's own sent documents; masters, everyone's. */
export const documentUploadsUrl = (): string => '/api/v1/document-uploads';
/** What a channel or playlist holds, to choose from (KBC-186). */
export const listEntriesUrl = (id: string): string =>
  `${documentUploadsUrl()}/${encodeURIComponent(id)}/entries`;
/** What each kind of content cost here (KBC-186): the estimate before sending. */
export const contentCostsUrl = (): string => `${documentUploadsUrl()}/costs`;
export const documentsUrl = (topic: string): string =>
  `/api/v1/topics/${encodeURIComponent(topic)}/documents`;

/** Retries of a part that did not arrive, as the media library's (ADR 0033). */
const RETRY_DELAYS_MS = [0, 1_000, 3_000, 5_000, 10_000, 20_000, 30_000];

export type SendEvent =
  | {
      readonly kind: 'progress';
      readonly loaded: number;
      readonly total: number;
    }
  | { readonly kind: 'done' };

/** Sending documents and links to a collection (KBC-149, ADR 0040). */
@Injectable({ providedIn: 'root' })
export class DocumentUploadsApi {
  private readonly http = inject(HttpClient);
  private readonly tus = inject(TUS_UPLOAD);
  private readonly work = inject(BusyWork);
  private sends = 0;

  /** "Documentos em processamento": one's own sent documents (masters: everyone's). */
  list(): Observable<DocumentUploadList> {
    return this.http
      .get(documentUploadsUrl())
      .pipe(map((body) => documentUploadListSchema.parse(body)));
  }

  /** What is ready leaves the list (it stays in the collection). */
  clearReady(ids: readonly string[]): Observable<unknown> {
    return this.http.post(`${documentUploadsUrl()}/clear-ready`, { ids });
  }

  /** A file announced (its bytes go by `send`) or a link; or what is already there (BR-3). */
  create(
    topic: string,
    request: CreateDocumentUploadRequest,
  ): Observable<CreateDocumentUploadResponse> {
    return this.http
      .post(documentsUrl(topic), request)
      .pipe(map((body) => createDocumentUploadResponseSchema.parse(body)));
  }

  /** A new ceiling for an inclusion: what waited for it goes on (KBC-009 R3). */
  changeBatch(id: string, capUsd: number): Observable<DocumentBatch> {
    return this.http
      .patch(`/api/v1/document-batches/${id}`, { capUsd })
      .pipe(map((body) => documentBatchSchema.parse(body)));
  }

  /** The recordings of a list that enter (KBC-186). */
  choose(
    id: string,
    urls: readonly string[],
  ): Observable<ChooseRecordingsResponse> {
    return this.http
      .post(`${documentUploadsUrl()}/${id}/choose`, { urls })
      .pipe(map((body) => chooseRecordingsResponseSchema.parse(body)));
  }

  /** A failed item goes again as it was sent. */
  retry(id: string): Observable<unknown> {
    return this.http.post(`${documentUploadsUrl()}/${id}/retry`, {});
  }

  /** Cancels an item the Mac does not have, or takes one that ended off the list. */
  remove(id: string): Observable<unknown> {
    return this.http.delete(`${documentUploadsUrl()}/${id}`);
  }

  /** The file's bytes over tus, from wherever the server stopped; unsubscribing stops. */
  send(uploadUrl: string, file: Blob): Observable<SendEvent> {
    return new Observable<SendEvent>((subscriber) => {
      // A new version of the app never reloads in the middle of a send (KBC-123 AC-2).
      const busyKey = `document-upload-${++this.sends}`;
      this.work.hold(busyKey);
      const session = this.tus(file, {
        uploadUrl,
        chunkSize: MEDIA_UPLOAD_PART_BYTES,
        retryDelays: RETRY_DELAYS_MS,
        storeFingerprintForResuming: false,
        headers: { [CSRF.header]: CSRF.value },
        onProgress: (loaded, total) =>
          subscriber.next({ kind: 'progress', loaded, total }),
        onSuccess: () => {
          subscriber.next({ kind: 'done' });
          subscriber.complete();
        },
        onError: (err) => subscriber.error(toHttpError(err)),
      });
      session.start();
      return () => {
        this.work.release(busyKey);
        void session.abort();
      };
    });
  }
}
