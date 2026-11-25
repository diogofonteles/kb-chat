import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import {
  webSearchResponseSchema,
  webSearchSettingsSchema,
  type WebSearchRequestInput,
  type WebSearchResponse,
  type WebSearchSettings,
} from '@kb-chat/contracts';
import { map, type Observable } from 'rxjs';

export const webSearchAvailableUrl = (): string =>
  '/api/v1/web-search/available';
export const webSearchSettingsUrl = (): string => '/api/v1/web-search/settings';
export const webSearchUrl = (topic: string): string =>
  `/api/v1/topics/${encodeURIComponent(topic)}/web-search`;

/** Searching the web for what to add to a collection, and the house's key (KBC-185). */
@Injectable({ providedIn: 'root' })
export class WebSearchApi {
  private readonly http = inject(HttpClient);

  /** Candidates only: nothing is added. Each kind asked costs the house's credits. */
  search(
    topic: string,
    request: WebSearchRequestInput,
  ): Observable<WebSearchResponse> {
    return this.http
      .post(webSearchUrl(topic), request)
      .pipe(map((body) => webSearchResponseSchema.parse(body)));
  }

  /** Masters: the key is kept only when Firecrawl accepts it. */
  connect(key: string): Observable<WebSearchSettings> {
    return this.http
      .put(webSearchSettingsUrl(), { key })
      .pipe(map((body) => webSearchSettingsSchema.parse(body)));
  }

  disconnect(): Observable<WebSearchSettings> {
    return this.http
      .delete(webSearchSettingsUrl())
      .pipe(map((body) => webSearchSettingsSchema.parse(body)));
  }
}
