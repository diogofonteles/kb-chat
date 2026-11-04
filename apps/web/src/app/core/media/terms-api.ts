import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import {
  termListSchema,
  termsUsageSchema,
  type SaveTermsRequest,
  type TermList,
  type TermsUsage,
} from '@kb-chat/contracts';
import { map, type Observable } from 'rxjs';

export const termsUrl = (): string => '/api/v1/media/terms';

/** "Termos da transcrição" (KBC-040): masters change the one list. */
@Injectable({ providedIn: 'root' })
export class TermsApi {
  private readonly http = inject(HttpClient);

  /** The count needs whisper's vocabulary, which stays on the server. */
  measure(terms: readonly string[]): Observable<TermsUsage> {
    return this.http
      .post(`${termsUrl()}/measure`, { terms })
      .pipe(map((body) => termsUsageSchema.parse(body)));
  }

  save(request: SaveTermsRequest): Observable<TermList> {
    return this.http
      .put(termsUrl(), request)
      .pipe(map((body) => termListSchema.parse(body)));
  }
}
