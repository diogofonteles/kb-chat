import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import {
  documentLevelSchema,
  topicLevelsSchema,
  type ContentLevel,
  type LevelCreate,
  type LevelRename,
  type TopicLevels,
} from '@kb-chat/contracts';
import { map, type Observable } from 'rxjs';
import { documentUrl } from '@core/api/kb-api.js';

/** A collection's scale (KBC-103 FR-1): a sub-collection answers with its parent's. */
export const topicLevelsUrl = (topic: string): string =>
  `/api/v1/topics/${encodeURIComponent(topic)}/levels`;
/** Every scale, as choices for the person editor (masters). */
export const levelScalesUrl = (): string => '/api/v1/levels';
/** The T24 page of a top-level collection. */
export const levelsPagePath = (topic: string): string[] => [
  '/acervos',
  topic,
  'niveis',
];

/** The writes of access levels (ADR 0036); reads use httpResource with the URLs above. */
@Injectable({ providedIn: 'root' })
export class LevelsApi {
  private readonly http = inject(HttpClient);

  create(topic: string, body: LevelCreate): Observable<TopicLevels> {
    return this.http
      .post(topicLevelsUrl(topic), body)
      .pipe(map((reply) => topicLevelsSchema.parse(reply)));
  }

  rename(
    topic: string,
    level: string,
    body: LevelRename,
  ): Observable<TopicLevels> {
    return this.http
      .patch(`${topicLevelsUrl(topic)}/${encodeURIComponent(level)}`, body)
      .pipe(map((reply) => topicLevelsSchema.parse(reply)));
  }

  reorder(topic: string, order: readonly string[]): Observable<TopicLevels> {
    return this.http
      .patch(topicLevelsUrl(topic), { order })
      .pipe(map((reply) => topicLevelsSchema.parse(reply)));
  }

  setDocumentLevel(
    target: { readonly topic: string; readonly id: string },
    level: string,
  ): Observable<ContentLevel> {
    return this.http
      .put(`${documentUrl(target.topic, target.id)}/level`, { level })
      .pipe(map((reply) => documentLevelSchema.parse(reply).level));
  }
}
