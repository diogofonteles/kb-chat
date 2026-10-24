import {
  HttpClient,
  HttpEventType,
  type HttpEvent,
} from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import {
  researchEventSchema,
  spendTodaySchema,
  type ResearchEvent,
  type ResearchRequest,
  type SpendToday,
} from '@kb-chat/contracts';
import { concatMap, from, map, type Observable } from 'rxjs';
import type { ZodType } from 'zod';

const topicPath = (topic: string): string =>
  `/api/v1/topics/${encodeURIComponent(topic)}`;

/** Parses the SSE text received so far with `schema`, returning only the events not seen yet. */
export function newEvents<T>(
  schema: ZodType<T>,
  partialText: string,
  alreadySeen: number,
): T[] {
  const blocks = partialText.split('\n\n');
  const complete = partialText.endsWith('\n\n') ? blocks : blocks.slice(0, -1);
  return complete
    .filter((block) => block.startsWith('data: '))
    .slice(alreadySeen)
    .map((block) => schema.parse(JSON.parse(block.slice(6))));
}

/** AI over HttpClient (ADR 0004, ADR 0006): today's spend and the streamed research agent. */
@Injectable({ providedIn: 'root' })
export class ResearchApi {
  private readonly http = inject(HttpClient);

  spendToday(): Observable<SpendToday> {
    return this.http
      .get('/api/v1/spend/today')
      .pipe(map((body) => spendTodaySchema.parse(body)));
  }

  /** Emits each agent event as it arrives; unsubscribing aborts the request (and the agent). */
  research(topic: string, request: ResearchRequest): Observable<ResearchEvent> {
    return this.stream(
      `${topicPath(topic)}/research`,
      request,
      researchEventSchema,
    );
  }

  private stream<T>(
    url: string,
    body: object,
    schema: ZodType<T>,
  ): Observable<T> {
    let seen = 0;
    return this.http
      .post(url, body, {
        observe: 'events',
        reportProgress: true,
        responseType: 'text',
      })
      .pipe(
        concatMap((event: HttpEvent<string>) => {
          const text = textOf(event);
          if (text === null) return from([]);
          const fresh = newEvents(schema, text, seen);
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
