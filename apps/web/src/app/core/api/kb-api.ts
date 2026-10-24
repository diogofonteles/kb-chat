import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import {
  relationPageSchema,
  searchResponseSchema,
  type RelationPage,
  type SearchRequest,
  type SearchResponse,
  type SeeAlsoGroupName,
} from '@kb-chat/contracts';
import { map, type Observable } from 'rxjs';

const topicPath = (topic: string): string =>
  `/api/v1/topics/${encodeURIComponent(topic)}`;

/** API URLs in one place; topic slugs may be nested ("a/b") and are always encoded. */
export const topicsUrl = (): string => '/api/v1/topics';
export const searchesUrl = (topic: string): string =>
  `${topicPath(topic)}/searches`;
export const documentUrl = (topic: string, id: string): string =>
  `${topicPath(topic)}/documents/${encodeURIComponent(id)}`;

/** Writes and event-driven calls to the kb-chat API (reads use httpResource with these URLs). */
@Injectable({ providedIn: 'root' })
export class KbApi {
  private readonly http = inject(HttpClient);

  search(topic: string, request: SearchRequest): Observable<SearchResponse> {
    return this.http
      .post(searchesUrl(topic), request)
      .pipe(map((body) => searchResponseSchema.parse(body)));
  }

  relations(
    topic: string,
    id: string,
    page: { group: SeeAlsoGroupName; offset: number },
  ): Observable<RelationPage> {
    return this.http
      .get(relationsUrl(topic, id, page.group), {
        params: { offset: page.offset, limit: 20 },
      })
      .pipe(map((body) => relationPageSchema.parse(body)));
  }
}

export const relationsUrl = (
  topic: string,
  id: string,
  group: string,
): string => `${documentUrl(topic, id)}/relations/${group}`;
