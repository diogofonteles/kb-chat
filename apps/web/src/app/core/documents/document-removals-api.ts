import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import {
  documentRemovalSchema,
  documentRestoreSchema,
  type DocumentRemoval,
} from '@kb-chat/contracts';
import { documentUrl } from '@core/api/kb-api.js';
import { Observable, map } from 'rxjs';

/** What was taken out of the collections (masters, KBC-187). */
export const documentRemovalsUrl = (): string => '/api/v1/document-removals';

const removalUrl = (id: string, what: 'restore' | 'retry'): string =>
  `${documentRemovalsUrl()}/${encodeURIComponent(id)}/${what}`;

/** A document out of its collection, and back (KBC-187). */
@Injectable({ providedIn: 'root' })
export class DocumentRemovalsApi {
  private readonly http = inject(HttpClient);

  remove(topic: string, documentId: string): Observable<DocumentRemoval> {
    return this.http
      .post(`${documentUrl(topic, documentId)}/removal`, {})
      .pipe(map((body) => documentRemovalSchema.parse(body)));
  }

  /** Null: it is back; else the Mac has to bring it. */
  restore(id: string): Observable<DocumentRemoval | null> {
    return this.http
      .post(removalUrl(id, 'restore'), {})
      .pipe(map((body) => documentRestoreSchema.parse(body).removal));
  }

  /** The Mac gave up on it. */
  retry(id: string): Observable<unknown> {
    return this.http.post(removalUrl(id, 'retry'), {});
  }
}
