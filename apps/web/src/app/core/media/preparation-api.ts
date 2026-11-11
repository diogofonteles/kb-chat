import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import {
  mediaPreparationSchema,
  processingQueueSchema,
  type MediaPreparation,
  type PreparationPlanRequest,
  type ProcessingQueue,
  type RetryStage,
  type RetryStageRequest,
} from '@kb-chat/contracts';
import { map, type Observable } from 'rxjs';
import { mediaUrl } from './media-api.js';

/** The guided flow "Preparar áudio" (KBC-072): its reads, for `httpResource`. */
export const preparationOptionsUrl = '/api/v1/media/preparation-options';
export const openPreparationsUrl = '/api/v1/media/preparations';
export const processingQueueUrl = '/api/v1/media/processing';
/** The queue of what is being processed (KBC-090). */
export const QUEUE_PAGE_PATH = '/fila';
export const preparationUrl = (id: string): string =>
  `${mediaUrl(id)}/preparation`;
/** Steps 1 and 2 of T20. */
export const preparationPagePath = (id: string): string =>
  `/midia/${encodeURIComponent(id)}/preparar`;

/** The writes of a recording's plan, each answering with where it now stands. */
@Injectable({ providedIn: 'root' })
export class PreparationApi {
  private readonly http = inject(HttpClient);

  queue(): Observable<ProcessingQueue> {
    return this.http
      .get(processingQueueUrl)
      .pipe(map((answer) => processingQueueSchema.parse(answer)));
  }

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

  /** `acceptedUsd`: the value in sight on a paid stage; a dearer run does not start. */
  retry(
    mediaId: string,
    stage: RetryStage,
    acceptedUsd?: number,
  ): Observable<MediaPreparation> {
    const body: RetryStageRequest =
      acceptedUsd === undefined ? {} : { acceptedUsd };
    return this.http
      .post(`${preparationUrl(mediaId)}/steps/${stage}/retry`, body)
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
