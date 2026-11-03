import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import {
  relationPageSchema,
  searchResponseSchema,
  topicSchema,
  type RelationPage,
  type SearchRequest,
  type SearchResponse,
  type SeeAlsoGroupName,
  type Topic,
  type TopicCreate,
  type TopicUpdate,
} from '@kb-chat/contracts';
import { map, type Observable } from 'rxjs';

const topicPath = (topic: string): string =>
  `/api/v1/topics/${encodeURIComponent(topic)}`;

/** API URLs in one place; topic slugs may be nested ("a/b") and are always encoded. */
export const topicsUrl = (): string => '/api/v1/topics';
export const eventsUrl = (): string => '/api/v1/events';
export const searchesUrl = (topic: string): string =>
  `${topicPath(topic)}/searches`;
export const suggestionsUrl = (topic: string): string =>
  `${topicPath(topic)}/suggestions`;
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

  /** A new collection or sub-collection (KBC-048 FR-1). */
  createTopic(body: TopicCreate): Observable<Topic> {
    return this.http
      .post(topicsUrl(), body)
      .pipe(map((reply) => topicSchema.parse(reply)));
  }

  /** New name or description; the slug stays (KBC-048 FR-2). */
  renameTopic(slug: string, body: TopicUpdate): Observable<Topic> {
    return this.http
      .patch(topicPath(slug), body)
      .pipe(map((reply) => topicSchema.parse(reply)));
  }

  relations(
    topic: string,
    id: string,
    page: { group: SeeAlsoGroupName; offset: number; limit: number },
  ): Observable<RelationPage> {
    return this.http
      .get(relationsUrl(topic, id, page.group), {
        params: { offset: page.offset, limit: page.limit },
      })
      .pipe(map((body) => relationPageSchema.parse(body)));
  }
}

export const relationsUrl = (
  topic: string,
  id: string,
  group: string,
): string => `${documentUrl(topic, id)}/relations/${group}`;
