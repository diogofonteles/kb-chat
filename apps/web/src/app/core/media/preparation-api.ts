import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import {
  mediaPreparationSchema,
  type MediaPreparation,
  type PreparationPlanRequest,
  type RetryStage,
} from '@kb-chat/contracts';
import { map, type Observable } from 'rxjs';
import { mediaUrl } from './media-api.js';

/** The guided flow "Preparar áudio" (KBC-072): its reads, for `httpResource`. */
export const preparationOptionsUrl = '/api/v1/media/preparation-options';
export const openPreparationsUrl = '/api/v1/media/preparations';
export const preparationUrl = (id: string): string =>
  `${mediaUrl(id)}/preparation`;
/** Steps 1 and 2 of T20. */
export const preparationPagePath = (id: string): string =>
  `/midia/${encodeURIComponent(id)}/preparar`;

/** The writes of a recording's plan, each answering with where it now stands. */
@Injectable({ providedIn: 'root' })
export class PreparationApi {
  private readonly http = inject(HttpClient);

  read(mediaId: string): Observable<MediaPreparation> {
    return this.http
      .get(preparationUrl(mediaId))
      .pipe(map((answer) => mediaPreparationSchema.parse(answer)));
  }

  start(
    mediaId: string,
    plan: PreparationPlanRequest,
  ): Observable<MediaPreparation> {
    return this.http
      .post(preparationUrl(mediaId), { plan })
      .pipe(map((answer) => mediaPreparationSchema.parse(answer)));
  }

  retry(mediaId: string, stage: RetryStage): Observable<MediaPreparation> {
    return this.http
      .post(`${preparationUrl(mediaId)}/steps/${stage}/retry`, {})
      .pipe(map((answer) => mediaPreparationSchema.parse(answer)));
  }

  /** "Marcar as faixas eu mesmo". */
  markByHand(mediaId: string): Observable<MediaPreparation> {
    return this.http
      .patch(preparationUrl(mediaId), { tracks: 'manual' })
      .pipe(map((answer) => mediaPreparationSchema.parse(answer)));
  }

  /** "Validar faixas" or "Concluir". */
  advance(mediaId: string): Observable<MediaPreparation> {
    return this.http
      .post(`${preparationUrl(mediaId)}/advance`, {})
      .pipe(map((answer) => mediaPreparationSchema.parse(answer)));
  }
}
