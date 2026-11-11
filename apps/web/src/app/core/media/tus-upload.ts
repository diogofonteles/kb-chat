import { HttpErrorResponse } from '@angular/common/http';
import { InjectionToken } from '@angular/core';
import { Upload, type DetailedError, type UploadOptions } from 'tus-js-client';

/** What the app uses of an upload over tus. */
export interface TusSession {
  start(): void;
  abort(): Promise<void>;
}

/** Starts a tus client on a file; tests swap it for a fake one. */
export type TusFactory = (file: Blob, options: UploadOptions) => TusSession;

export const TUS_UPLOAD = new InjectionToken<TusFactory>('TUS_UPLOAD', {
  providedIn: 'root',
  factory: () => (file, options) => new Upload(file, options),
});

/** A failure of tus as the HTTP error the rest of the app reads; status 0 for no answer. */
export function toHttpError(err: Error | DetailedError): HttpErrorResponse {
  const response = 'originalResponse' in err ? err.originalResponse : null;
  return new HttpErrorResponse({
    status: response?.getStatus() ?? 0,
    error: response?.getBody() ?? null,
  });
}
