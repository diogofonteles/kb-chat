import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import {
  documentSchema,
  searchResponseSchema,
  topicListSchema,
  type KbDocument,
  type SearchRequest,
  type SearchResponse,
  type TopicList,
} from '@kb-chat/contracts';
import { map, type Observable } from 'rxjs';

/** Single entry point to the kb-chat API; responses are parsed with the shared contracts. */
@Injectable({ providedIn: 'root' })
export class KbApi {
  private readonly http = inject(HttpClient);

  listTopics(): Observable<TopicList> {
    return this.http
      .get('/api/v1/topics')
      .pipe(map((body) => topicListSchema.parse(body)));
  }

  search(topic: string, request: SearchRequest): Observable<SearchResponse> {
    return this.http
      .post(`/api/v1/topics/${topic}/searches`, request)
      .pipe(map((body) => searchResponseSchema.parse(body)));
  }

  getDocument(topic: string, id: string): Observable<KbDocument> {
    return this.http
      .get(`/api/v1/topics/${topic}/documents/${encodeURIComponent(id)}`)
      .pipe(map((body) => documentSchema.parse(body)));
  }
}

export const documentUrl = (topic: string, id: string): string =>
  `/api/v1/topics/${topic}/documents/${encodeURIComponent(id)}`;
