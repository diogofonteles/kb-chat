import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import {
  bulkLevelResultSchema,
  documentLevelSchema,
  levelAuditPageSchema,
  levelPreviewSchema,
  topicLevelsSchema,
  type LevelAuditPage,
  type LevelAuditQuery,
  type LevelDelete,
  type LevelPreview,
  type LevelPreviewRequest,
  type BulkLevelRequest,
  type BulkLevelResult,
  type ContentLevel,
  type UnassignedPage,
  unassignedPageSchema,
  type UnassignedFilter,
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
/** The "Sem nível" queue of a collection, a page at a time (KBC-107 FR-1). */
export const unassignedUrl = (
  topic: string,
  query: UnassignedFilter & {
    readonly cursor?: string;
    readonly limit?: number;
  },
): string => {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query))
    if (value !== undefined) params.set(key, String(value));
  const search = params.toString();
  return `${topicLevelsUrl(topic)}/unassigned${search ? `?${search}` : ''}`;
};
/** The levels the signed-in person may give in a collection (T3, search, KBC-107). */
export const levelChoicesUrl = (topic: string): string =>
  `${topicLevelsUrl(topic)}/choices`;
/** "N documentos sem nível" per collection (the sidebar, KBC-107 FR-6). */
export const unassignedCountsUrl = (): string => '/api/v1/levels/unassigned';
/** "Histórico de níveis" (KBC-108 FR-4): masters only. */
export const levelAuditUrl = (query: LevelAuditQuery): string => {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query))
    if (value !== undefined && value !== '') params.set(key, String(value));
  const search = params.toString();
  return `/api/v1/levels/audit${search ? `?${search}` : ''}`;
};
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

  /** The new order, applied only on the version its preview was made on (KBC-108 BR-3). */
  reorder(
    topic: string,
    change: { readonly order: readonly string[]; readonly version: string },
  ): Observable<TopicLevels> {
    return this.http
      .patch(topicLevelsUrl(topic), change)
      .pipe(map((reply) => topicLevelsSchema.parse(reply)));
  }

  /** Who gains and who loses what, before a reorder or a removal (KBC-108 FR-2). */
  preview(topic: string, body: LevelPreviewRequest): Observable<LevelPreview> {
    return this.http
      .post(`${topicLevelsUrl(topic)}/preview`, body)
      .pipe(map((reply) => levelPreviewSchema.parse(reply)));
  }

  /** A level goes, its content and its people to the targets (KBC-108 FR-1). */
  remove(
    topic: string,
    level: string,
    body: LevelDelete,
  ): Observable<TopicLevels> {
    return this.http
      .delete(`${topicLevelsUrl(topic)}/${encodeURIComponent(level)}`, { body })
      .pipe(map((reply) => topicLevelsSchema.parse(reply)));
  }

  /** Every level goes, confirmed by the collection (KBC-108 FR-3). */
  clear(topic: string, version: string): Observable<TopicLevels> {
    return this.http
      .delete(topicLevelsUrl(topic), { body: { confirm: topic, version } })
      .pipe(map((reply) => topicLevelsSchema.parse(reply)));
  }

  /** "Carregar mais" of the history; the first page is an httpResource. */
  history(query: LevelAuditQuery): Observable<LevelAuditPage> {
    return this.http
      .get(levelAuditUrl(query))
      .pipe(map((reply) => levelAuditPageSchema.parse(reply)));
  }

  /** One more page of the queue ("Carregar mais"); the first is an httpResource. */
  unassigned(
    topic: string,
    query: Parameters<typeof unassignedUrl>[1],
  ): Observable<UnassignedPage> {
    return this.http
      .get(unassignedUrl(topic, query))
      .pipe(map((reply) => unassignedPageSchema.parse(reply)));
  }

  /** A level for a selection, or for the queue a filter keeps as of its list (FR-2). */
  setLevels(
    topic: string,
    body: BulkLevelRequest,
  ): Observable<BulkLevelResult> {
    return this.http
      .post(`/api/v1/topics/${encodeURIComponent(topic)}/document-levels`, body)
      .pipe(map((reply) => bulkLevelResultSchema.parse(reply)));
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
