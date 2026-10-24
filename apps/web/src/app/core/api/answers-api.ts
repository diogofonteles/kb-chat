import {
  HttpClient,
  HttpEventType,
  type HttpEvent,
} from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import {
  answerEstimateSchema,
  answerEventSchema,
  spendTodaySchema,
  type AnswerEstimate,
  type AnswerEvent,
  type AnswerRequest,
  type SpendToday,
} from '@kb-chat/contracts';
import { concatMap, from, map, type Observable } from 'rxjs';

const topicPath = (topic: string): string =>
  `/api/v1/topics/${encodeURIComponent(topic)}`;

/** Parses the SSE text received so far, returning only the events not seen yet. */
export function newEvents(
  partialText: string,
  alreadySeen: number,
): AnswerEvent[] {
  const blocks = partialText.split('\n\n');
  const complete = partialText.endsWith('\n\n') ? blocks : blocks.slice(0, -1);
  return complete
    .filter((block) => block.startsWith('data: '))
    .slice(alreadySeen)
    .map((block) => answerEventSchema.parse(JSON.parse(block.slice(6))));
}

/** AI answers (ADR 0004): estimate, spend and the streamed answer over HttpClient. */
@Injectable({ providedIn: 'root' })
export class AnswersApi {
  private readonly http = inject(HttpClient);

  estimate(topic: string, request: AnswerRequest): Observable<AnswerEstimate> {
    return this.http
      .post(`${topicPath(topic)}/answers/estimates`, request)
      .pipe(map((body) => answerEstimateSchema.parse(body)));
  }

  spendToday(): Observable<SpendToday> {
    return this.http
      .get('/api/v1/spend/today')
      .pipe(map((body) => spendTodaySchema.parse(body)));
  }

  /** Emits each server-sent event as it arrives; unsubscribing aborts the request (and the model). */
  answer(
    topic: string,
    request: AnswerRequest,
    idempotencyKey: string,
  ): Observable<AnswerEvent> {
    let seen = 0;
    return this.http
      .post(`${topicPath(topic)}/answers`, request, {
        headers: { 'idempotency-key': idempotencyKey },
        observe: 'events',
        reportProgress: true,
        responseType: 'text',
      })
      .pipe(
        concatMap((event: HttpEvent<string>) => {
          const text = textOf(event);
          if (text === null) return from([]);
          const fresh = newEvents(text, seen);
          seen += fresh.length;
          return from(fresh);
        }),
      );
  }
}

function textOf(event: HttpEvent<string>): string | null {
  if (event.type === HttpEventType.DownloadProgress)
    return event.partialText ?? null;
  if (event.type === HttpEventType.Response) return event.body ?? '';
  return null;
}
